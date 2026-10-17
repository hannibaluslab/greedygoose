import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  http,
  isAddressEqual,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { base } from "viem/chains";
import {
  buildGrantPermissionCall,
  buildRevokePermissionCall,
  type PermissionsDetail,
  type StorePermissionApiResponse,
} from "@jaw.id/core";
import { CHAIN_ID } from "@/lib/chain";
import { justanAccountAbi, permissionManagerAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";
import { isLocalRpc } from "./flag";

/**
 * The dress rehearsal's fork signer (scripts/rehearsal/README.md): an EIP-1193 provider that answers the wallet
 * methods the app asks JAW for, on a local anvil fork of Base with fake money.
 *
 * - `wallet_sendCalls` runs the batch as the account's own `executeBatch`, sent by its owner: one of anvil's unlocked
 *   dev accounts, which JAW's real factory made an owner next to the permission manager (`setup.ts`). All or nothing,
 *   like a JAW user operation. Anvil signs; no key is in this code or in the browser.
 * - `wallet_grantPermissions` and `wallet_revokePermissions` make the same on-chain calls JAW's grant and revoke make
 *   (`manager.approve` / `manager.revoke` from the account), built by JAW's own SDK (`buildGrantPermissionCall`,
 *   `buildRevokePermissionCall` in @jaw.id/core): start from this browser's clock, a random salt, checker 0 on every
 *   call (contracts/docs/MANAGER-NOTES.md §5).
 * - `wallet_getPermissions` stands in for JAW's relay: every permission the manager approved for the account on the
 *   fork that it hasn't revoked, read from its events.
 * - `wallet_getCallsHistory` lists what this signer sent, from this browser.
 *
 * Before any write it checks that it is talking to anvil on this machine, on chain 8453, and that the account's owner
 * is unlocked there and owns it. Fees are paid in the fork's ETH by the owner: no USDC fee is charged.
 *
 * Development only: `lib/jaw/config.ts` loads it only outside production, and a production build drops it
 * (`npm run rehearsal:check-build`).
 */

/** Searched for in a production build's output by `npm run rehearsal:check-build`: it must never be found. */
export const REHEARSAL_SIGNER_MARKER = "gg-rehearsal-fork-signer";

const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}` as const;
const MANAGER = PROTOCOLS.PERMISSION_MANAGER as Address;
const APPROVED = getAbiItem({ abi: permissionManagerAbi, name: "PermissionApproved" });
const REVOKED = getAbiItem({ abi: permissionManagerAbi, name: "PermissionRevoked" });
/** JustaPermissionManager's PeriodUnit, in the words JAW's relay stores. */
const UNITS = ["minute", "hour", "day", "week", "month", "forever"] as const;

const executeBatchAbi = [
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple[]",
        name: "calls",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/** The methods a read can be forwarded to the fork with. Anything that signs or sends is answered here or refused. */
const READS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_simulateV1",
  "net_version",
  "web3_clientVersion",
]);

type Call = { target: Address; value: bigint; data: Hex };
type Request = { method: string; params?: unknown };
type HistoryItem = {
  id: Hex;
  index: number;
  address: Address;
  status: number;
  timestamp: number;
  chainId: number;
  transactionHash: Hex | null;
};
type Listener = (...args: unknown[]) => void;

/** An EIP-1193 error: 4001 rejected, 4200 unsupported, 4902 unknown chain, -32602 bad params. */
class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;

export type ForkSignerOptions = {
  /** The fork's RPC (local only). */
  rpc: string;
  /** The rehearsal account, a JAW account made by JAW's factory on the fork. */
  account: Address;
  /** Its owner: an unlocked anvil dev account. */
  signer: Address;
  /** The first block after the fork point: logs before it would be asked of Base itself. */
  fromBlock: bigint;
};

export type ForkSigner = ReturnType<typeof createForkSigner>;

export function createForkSigner(o: ForkSignerOptions) {
  if (process.env.NODE_ENV === "production") throw new Error("The rehearsal's fork signer is for development only");
  if (!isLocalRpc(o.rpc)) throw new Error("The rehearsal's fork signer only talks to a local anvil fork");
  const client = createPublicClient({ chain: base, transport: http(o.rpc, { timeout: 60_000 }) });
  const listeners = new Map<string, Set<Listener>>();
  let checked: Promise<void> | null = null;

  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((fn) => fn(...args));

  /** Anvil on this machine, chain 8453, and an unlocked owner of the account: checked once, before the first write. */
  function assertFork(): Promise<void> {
    checked ??= (async () => {
      const version = await client.request({ method: "web3_clientVersion" });
      if (!String(version).startsWith("anvil/")) throw new ProviderError(4900, `Not an anvil fork: ${version}`);
      if ((await client.getChainId()) !== CHAIN_ID) throw new ProviderError(4901, "The fork isn't on chain 8453");
      const unlocked = (await client.request({ method: "eth_accounts" } as never)) as Address[];
      if (!unlocked.some((a) => isAddressEqual(a, o.signer)))
        throw new ProviderError(4100, "The account's owner isn't unlocked on the fork");
      const owns = await client.readContract({
        address: o.account,
        abi: justanAccountAbi,
        functionName: "isOwnerAddress",
        args: [o.signer],
      });
      if (!owns)
        throw new ProviderError(4100, "The rehearsal signer doesn't own this account: run the rehearsal setup again");
    })().catch((e) => {
      checked = null;
      throw e;
    });
    return checked;
  }

  /** The batch as the account's own executeBatch, sent by its owner. Returns the transaction hash. */
  async function sendBatch(calls: Call[]): Promise<Hex> {
    await assertFork();
    const data = encodeFunctionData({ abi: executeBatchAbi, functionName: "executeBatch", args: [calls] });
    // anvil's estimate for a deep batch can come up short on a fork: pad it the way a bundler pads a user operation.
    const estimate = await client.estimateGas({ account: o.signer, to: o.account, data });
    const gas = (estimate * 3n) / 2n + 100_000n;
    return (await client.request({
      method: "eth_sendTransaction",
      params: [{ from: o.signer, to: o.account, data, gas: hex(gas) }],
    } as never)) as Hex;
  }

  async function landed(hash: Hex) {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new ProviderError(-32603, "The batch reverted on the fork");
    return receipt;
  }

  // ------------------------------------------------------------------ history (this browser)

  const historyKey = `gg.rehearsal.history.${o.account.toLowerCase()}`;
  function readHistory(): HistoryItem[] {
    try {
      const raw = globalThis.localStorage?.getItem(historyKey);
      return raw ? (JSON.parse(raw) as HistoryItem[]) : [];
    } catch {
      return [];
    }
  }
  function writeHistory(items: HistoryItem[]) {
    try {
      globalThis.localStorage?.setItem(historyKey, JSON.stringify(items));
    } catch {}
  }
  function remember(hash: Hex) {
    const items = readHistory();
    items.push({
      id: hash,
      index: items.length,
      address: o.account,
      status: 100,
      timestamp: Math.floor(Date.now() / 1000),
      chainId: CHAIN_ID,
      transactionHash: hash,
    });
    writeHistory(items);
  }

  async function history(params: { limit?: number; sort?: "asc" | "desc" } | undefined) {
    const items = readHistory();
    for (const item of items.filter((i) => i.status === 100 && i.transactionHash)) {
      const r = (await client.request({ method: "eth_getTransactionReceipt", params: [item.transactionHash!] })) as {
        status: Hex;
      } | null;
      if (r) item.status = r.status === "0x1" ? 200 : 500;
    }
    writeHistory(items);
    const sorted = [...items].sort((a, b) => (params?.sort === "asc" ? a.index - b.index : b.index - a.index));
    return sorted.slice(0, params?.limit ?? 20);
  }

  // ------------------------------------------------------------------ permissions (JAW's relay, from the chain)

  /** Every permission the manager approved for `address` on the fork and hasn't revoked, as JAW's relay lists it. */
  async function relay(address: Address): Promise<StorePermissionApiResponse[]> {
    const [approved, revoked] = await Promise.all([
      client.getLogs({ address: MANAGER, event: APPROVED, fromBlock: o.fromBlock, toBlock: "latest" }),
      client.getLogs({ address: MANAGER, event: REVOKED, fromBlock: o.fromBlock, toBlock: "latest" }),
    ]);
    const gone = new Set(revoked.map((l) => l.args.permissionHash?.toLowerCase()));
    return approved.flatMap((l) => {
      const p = l.args.permission;
      const id = l.args.permissionHash;
      if (!p || !id || !isAddressEqual(p.account, address) || gone.has(id.toLowerCase())) return [];
      return [
        {
          permissionId: id,
          account: p.account,
          spender: p.spender,
          start: p.start,
          end: p.end,
          salt: hex(p.salt),
          calls: p.calls.map((c) => ({ target: c.target, selector: c.selector, checker: c.checker })),
          spends: p.spends.map((s) => ({
            token: s.token,
            allowance: hex(s.allowance),
            unit: UNITS[s.unit],
            multiplier: s.multiplier,
          })),
          chainId: CHAIN_HEX,
        },
      ];
    });
  }

  async function grant(params: { expiry: number; spender: Address; permissions: PermissionsDetail; chainId?: string }) {
    if (params.chainId && Number(params.chainId) !== CHAIN_ID)
      throw new ProviderError(4902, "The rehearsal runs on Base (8453) only");
    // JAW's own builder: the permission its grant approves, and the approve call that ends its user operation.
    const call = buildGrantPermissionCall(o.account, params.spender, params.expiry, params.permissions);
    if (!isAddressEqual(call.to, MANAGER)) throw new ProviderError(-32603, "JAW's grant targets another manager");
    const decoded = decodeFunctionData({ abi: permissionManagerAbi, data: call.data });
    if (decoded.functionName !== "approve") throw new ProviderError(-32603, "JAW's grant isn't an approve");
    const p = decoded.args[0];
    const hash = await sendBatch([{ target: call.to, value: 0n, data: call.data }]);
    remember(hash);
    const receipt = await landed(hash);
    const permissionId = approvedHash(receipt.logs);
    emit("message", { type: "permissionsChanged" });
    // The response JAW's grantPermissions returns (core rpc/permissions.js).
    return {
      account: o.account,
      spender: params.spender,
      start: p.start,
      end: p.end,
      salt: hex(p.salt),
      calls: p.calls.map((c) => ({ target: c.target, selector: c.selector })),
      spends: p.spends.map((s, i) => ({
        token: s.token,
        allowance: hex(s.allowance),
        unit: params.permissions.spends?.[i]?.unit ?? UNITS[s.unit],
        multiplier: s.multiplier,
      })),
      permissionId,
      chainId: CHAIN_HEX,
    };
  }

  async function revoke(params: { address?: Address; id: Hex }) {
    const record = (await relay(o.account)).find((r) => r.permissionId.toLowerCase() === params.id.toLowerCase());
    if (!record) throw new ProviderError(-32602, "Permission not found");
    const call = buildRevokePermissionCall(record);
    const hash = await sendBatch([{ target: call.to, value: 0n, data: call.data }]);
    remember(hash);
    await landed(hash);
    emit("message", { type: "permissionsChanged" });
    return { success: true };
  }

  // ------------------------------------------------------------------ calls

  async function sendCalls(params: {
    chainId?: string;
    from?: Address;
    calls: { to: Address; data?: Hex; value?: Hex }[];
  }) {
    if (params.chainId && Number(params.chainId) !== CHAIN_ID)
      throw new ProviderError(4902, "The rehearsal runs on Base (8453) only");
    if (params.from && !isAddressEqual(params.from, o.account))
      throw new ProviderError(4100, "Only the rehearsal account signs here");
    if (!params.calls?.length) throw new ProviderError(-32602, "No calls");
    const calls = params.calls.map((c) => ({
      target: c.to,
      value: c.value ? BigInt(c.value) : 0n,
      data: c.data ?? "0x",
    }));
    const hash = await sendBatch(calls);
    remember(hash);
    return { id: hash };
  }

  async function callsStatus(id: Hex) {
    const receipt = (await client.request({ method: "eth_getTransactionReceipt", params: [id] })) as {
      status: Hex;
    } | null;
    return {
      version: "2.0.0",
      id,
      chainId: CHAIN_HEX,
      atomic: true,
      status: !receipt ? 100 : receipt.status === "0x1" ? 200 : 500,
      receipts: receipt ? [receipt] : undefined,
    };
  }

  /** JAW on Base: batches are atomic, and the fee is taken in USDC (on the fork the owner pays it in ETH). */
  const capabilities = {
    [CHAIN_HEX]: {
      atomic: { status: "supported" },
      feeToken: {
        supported: true,
        tokens: [
          {
            uid: "usdc",
            symbol: USDC.symbol,
            address: USDC.address,
            interop: false,
            decimals: USDC.decimals,
            feeToken: true,
          },
        ],
      },
      rehearsal: { fork: true, signer: REHEARSAL_SIGNER_MARKER },
    },
  };

  async function request({ method, params }: Request): Promise<unknown> {
    const p = (Array.isArray(params) ? params : []) as never[];
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [o.account];
      case "eth_chainId":
        return CHAIN_HEX;
      case "wallet_switchEthereumChain":
        if (Number((p[0] as { chainId: string } | undefined)?.chainId) !== CHAIN_ID)
          throw new ProviderError(4902, "The rehearsal runs on Base only");
        return null;
      case "wallet_getCapabilities":
        return capabilities;
      case "wallet_sendCalls":
        return sendCalls(p[0]);
      case "wallet_getCallsStatus":
        return callsStatus(p[0]);
      case "wallet_showCallsStatus":
        return null;
      case "wallet_grantPermissions":
        return grant(p[0]);
      case "wallet_getPermissions":
        return relay(((p[0] as { address?: Address } | undefined)?.address ?? o.account) as Address);
      case "wallet_revokePermissions":
        return revoke(p[0]);
      case "wallet_getCallsHistory":
        return history(p[0]);
    }
    if (READS.has(method)) return client.request({ method, params } as never);
    throw new ProviderError(4200, `${method} isn't part of the rehearsal's fork signer`);
  }

  return {
    request,
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
    },
    assertFork,
  };
}

/** The permission hash in a grant's receipt, from the manager's PermissionApproved (as JAW's SDK reads it). */
function approvedHash(logs: readonly Log[]): Hex {
  for (const log of logs) {
    if (!isAddressEqual(log.address, MANAGER)) continue;
    try {
      const e = decodeEventLog({ abi: permissionManagerAbi, data: log.data, topics: log.topics });
      if (e.eventName === "PermissionApproved") return e.args.permissionHash;
    } catch {}
  }
  throw new ProviderError(-32603, "PermissionApproved event not found in transaction receipt");
}

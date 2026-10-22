/**
 * Shared by the rehearsal scripts (scripts/rehearsal/README.md). Everything here talks to a local anvil fork of Base
 * only: `connectFork` refuses any RPC that isn't on this machine, isn't anvil or isn't chain 8453. Transactions are
 * sent from anvil's own unlocked dev accounts (eth_sendTransaction), so no private key appears anywhere.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  isAddressEqual,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { MOVES } from "@/lib/agents/events";
import { unpackMix } from "@/lib/agents/mix";
import { isLocalRpc } from "@/lib/rehearsal/flag";
import { statusFor, STATUS_LABEL } from "@/lib/risk/status";
import { EQUITIES } from "@/lib/tokens/registry";
import { CASH_COINS } from "@/lib/tokens/stables";

export const ROOT = resolve(__dirname, "../..");
export const STATE_DIR = join(ROOT, ".rehearsal");
export const STATE_FILE = join(STATE_DIR, "state.json");
export const ENV_FILE = join(ROOT, ".env.rehearsal.local");
export const PORT = Number(process.env.REHEARSAL_PORT ?? 18545);
export const RPC = process.env.REHEARSAL_RPC ?? `http://127.0.0.1:${PORT}`;

/** The rehearsal's two accounts, by name. */
export const NAMES = ["sam", "ana"] as const;
export type Name = (typeof NAMES)[number];

export type State = {
  rpc: string;
  forkUrl: string;
  forkBlock: number;
  /** The first block after the fork point: logs before it would be asked of Base, which refuses eth_getLogs. */
  fromBlock: number;
  /** anvil dev accounts: GooseGuard's owner (and deployer) and its one runner, in KeeperHub's place. */
  owner: Address;
  runner: Address;
  guard: Address;
  guardBlock: number;
  /** GoosePlanner, once it is built and deployed on the fork: run-agents reads its plan. */
  planner?: Address;
  accounts: Record<Name, { address: Address; signer: Address }>;
  /** price-shock: each oracle source it replaced, with the code to put back. */
  feeds: Record<string, { source: Address; code: Hex }>;
};

export function readState(): State {
  if (!existsSync(STATE_FILE)) throw new Error("No rehearsal yet: run npm run rehearsal:setup");
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}

export function writeState(s: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

export type Call = { target: Address; value: bigint; data: Hex };

export const executeBatchAbi = [
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

/** The local anvil fork, or an error: never a remote node, never another chain. */
export async function connectFork(rpc = RPC) {
  if (!isLocalRpc(rpc)) throw new Error(`The rehearsal only runs against a local anvil fork, not ${rpc}`);
  const transport = http(rpc);
  const pub = createPublicClient({ chain: base, transport });
  let version: string;
  try {
    version = await pub.request({ method: "web3_clientVersion" });
  } catch {
    throw new Error(`No fork at ${rpc}: start it with npm run rehearsal:fork`);
  }
  if (!version.startsWith("anvil/")) throw new Error(`${rpc} is ${version}, not anvil`);
  if ((await pub.getChainId()) !== base.id) throw new Error(`${rpc} isn't on chain 8453`);
  const dev = (await pub.request({ method: "eth_accounts" } as never)) as Address[];
  if (dev.length < 4) throw new Error("anvil needs at least 4 dev accounts");
  const test = createTestClient({ chain: base, transport, mode: "anvil" });
  const wallet = createWalletClient({ chain: base, transport });

  /** A transaction from one of anvil's unlocked dev accounts; throws if it reverts. `gas` fixes its gas limit. */
  async function send(from: Address, to: Address, data: Hex, what: string, gas?: bigint): Promise<TransactionReceipt> {
    if (!dev.some((d) => isAddressEqual(d, from))) throw new Error(`${from} isn't an unlocked anvil dev account`);
    const hash = await wallet.sendTransaction({
      account: from,
      to,
      data,
      chain: base,
      gas: gas ?? (await gasFor(pub, { from, to, data })),
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what} reverted (${hash})`);
    return receipt;
  }

  /** A batch as the JAW account's own executeBatch, sent by its owner: what a JAW user operation runs. */
  function batch(signer: Address, account: Address, calls: Call[], what: string) {
    return send(
      signer,
      account,
      encodeFunctionData({ abi: executeBatchAbi, functionName: "executeBatch", args: [calls] }),
      what,
    );
  }

  return { rpc, pub, test, wallet, dev, send, batch };
}

export type Fork = Awaited<ReturnType<typeof connectFork>>;

/**
 * anvil's estimate for a deep batch on a fork can come up short (an Aave V3 supply ran out of gas in its incentives
 * hook), so every transaction gets half as much again, plus 100k, the way a bundler pads a user operation.
 */
export async function gasFor(pub: Fork["pub"], tx: { from: Address; to: Address; data: Hex }) {
  const estimate = await pub.estimateGas({ account: tx.from, to: tx.to, data: tx.data });
  return (estimate * 3n) / 2n + 100_000n;
}

// ------------------------------------------------------------------ words

export const usd = (raw: bigint, decimals = 6) =>
  `$${(Number(raw) / 10 ** decimals).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const shares = (raw: bigint) => `${(Number(raw) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
export const hf = (wad: bigint) => (wad >= 2n ** 255n ? "∞" : (Number(wad) / 1e18).toFixed(3));
/** "1.462 (Watch)", from Aave's health factor (WAD), with the app's bands (config/risk.ts). */
export const health = (wad: bigint) => {
  const n = wad >= 2n ** 255n ? Infinity : Number(wad) / 1e18;
  return `${hf(wad)} (${STATUS_LABEL[statusFor(n)]})`;
};
export const nyTime = (sec: number | bigint) =>
  new Date(Number(sec) * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }) + " New York";

/** The agents' names on screen (JUSTALAB-DECISIONS, "Four agents, one name each"), by GooseGuard's job. */
const JOB_NAMES = ["Save", "Protect", "Protect · sell", "Rebalance", "Receive"] as const;

const stockList = (amounts: readonly bigint[]) =>
  amounts.flatMap((a, r) => (a > 0n ? [`${shares(a)} ${EQUITIES[r].symbol}`] : [])).join(", ") || "nothing";

/** Each GooseGuard event in a receipt, in words. `who` names an account. */
export function describeGuardLogs(logs: readonly Log[], guard: Address, who: (a: Address) => string): string[] {
  const out: string[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, guard)) continue;
    let e;
    try {
      e = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const a = e.args as Record<string, unknown>;
    const name = typeof a.account === "string" ? who(a.account as Address) : "";
    switch (e.eventName) {
      case "JobOn":
        out.push(
          `${name}: ${JOB_NAMES[Number(a.job)]} is on, no limit, until ${new Date(Number(a.end) * 1000).toISOString().slice(0, 10)}`,
        );
        break;
      case "JobOff":
        out.push(`${name}: ${JOB_NAMES[Number(a.job)]} is off`);
        break;
      case "Saved":
        out.push(`${name}: Save put ${usd(a.amount as bigint)} into savings`);
        break;
      case "ProtectRepaid":
        out.push(
          `${name}: Protect repaid ${usd(a.fromWallet as bigint)} from the wallet and ${usd(a.fromSavings as bigint)} from savings, health ${hf(a.hfBefore as bigint)} → ${health(a.hfAfter as bigint)}`,
        );
        break;
      case "ProtectSold":
        out.push(
          `${name}: Protect sold ${stockList(a.shares as bigint[])} and repaid ${usd(a.repaid as bigint)}, health ${hf(a.hfBefore as bigint)} → ${health(a.hfAfter as bigint)}`,
        );
        break;
      case "ConfigRefreshed":
        out.push(
          `${name}: Aave's latest settings applied, health ${hf(a.hfBefore as bigint)} → ${health(a.hfAfter as bigint)}`,
        );
        break;
      case "RescueEnded":
        out.push(`${name}: the rescue ended`);
        break;
      case "Rebalanced":
        out.push(
          `${name}: Rebalance sold ${stockList(a.sold as bigint[])} and bought ${stockList(a.bought as bigint[])}`,
        );
        break;
      case "TopUpsSet":
        out.push(`${name}: top-ups into the mix ${a.on ? "on" : "off"}, keep ${usd(BigInt(a.keep as number))} as cash`);
        break;
      case "TopUpInvested":
        out.push(
          `${name}: Rebalance put ${usd(a.amount as bigint)} of top-ups into the mix, bought ${stockList(a.bought as bigint[])}`,
        );
        break;
      case "MixSet":
        out.push(
          `${name}: mix ${unpackMix(a.mix as bigint)
            .map((w) => w / 100)
            .join("/")}`,
        );
        break;
      case "EntryConverted": {
        const coin = CASH_COINS.find((c) => isAddressEqual(c.address, a.coin as Address));
        out.push(
          `${name}: Receive converted ${usd(a.amountIn as bigint, coin?.decimals ?? 6)} of ${coin?.symbol ?? a.coin} into ${usd(a.usdcOut as bigint)} of USDC`,
        );
        break;
      }
      case "Refused":
        out.push(
          `${name}: a ${MOVES[Number(a.kind)] ?? a.kind} was refused (${errorName(a.reason as Hex)}); next round`,
        );
        break;
      default:
        out.push(`${e.eventName}`);
    }
  }
  return out;
}

/** The manager's errors the fork suites name (contracts/test), so a failed run reads by name. */
const managerErrors = parseAbi([
  "error JustaPermissionManager_CheckerRejectedCall(address,bytes4,address)",
  "error JustaPermissionManager_ExceededSpendLimit(uint256,uint256)",
  "error JustaPermissionManager_InvalidSender(address,address)",
  "error JustaPermissionManager_UnauthorizedCall(address,bytes4)",
  "error JustaPermissionManager_UnauthorizedPermission()",
]);

/** A revert selector, by name when GooseGuard or JAW's manager declares it. */
export function errorName(selector: Hex): string {
  for (const abi of [guardAbi, managerErrors]) {
    for (const i of abi) {
      if (i.type !== "error") continue;
      const signature = `${i.name}(${i.inputs.map((p) => p.type).join(",")})`;
      if (toFunctionSelector(signature) === selector.toLowerCase()) return i.name;
    }
  }
  return selector;
}

/** The account's name in the rehearsal, or its address. */
export function namer(state: State) {
  return (a: Address) => NAMES.find((n) => isAddressEqual(state.accounts[n].address, a)) ?? a;
}

import { isAddressEqual, parseAbiItem, type Account, type Address, type PublicClient, type Transport, type WalletClient } from "viem";
import type { base } from "viem/chains";

/** Clients are Base clients (OP-stack formatters), matching lib/chain.ts. */
type Reader = PublicClient<Transport, typeof base>;
type Signer = WalletClient<Transport, typeof base, Account>;
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { summarize, type AccountData } from "@/lib/aave/math";
import { USDC } from "@/lib/tokens/registry";
import { GUARDIAN } from "./config";
import { permissionManagerAbi } from "./abis";
import { buildRescueCalls, toTuple, type GuardianPermission } from "./permission";
import { inWeekendWindow, planGuardian, type GuardianDecision } from "./plan";

/**
 * Guardian keeper core. Holds no user funds and no user keys: it can only call
 * JustaPermissionManager.executeBatch with permissions users approved for its spender address,
 * and the GuardianChecker + spend cap limit what those calls can do on-chain.
 */

const approvedEvent = parseAbiItem(
  "event PermissionApproved(bytes32 indexed permissionHash, (address account,address spender,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends) permission)",
);

/** Find Guardian permissions granted to this keeper (all calls guarded by our checker) in a block range. */
export async function discoverPermissions(
  client: Reader,
  p: { keeper: Address; checker: Address; fromBlock: bigint; toBlock: bigint; chunk?: bigint },
): Promise<GuardianPermission[]> {
  const chunk = p.chunk ?? 5_000n;
  const found: GuardianPermission[] = [];
  for (let from = p.fromBlock; from <= p.toBlock; from += chunk) {
    const to = from + chunk - 1n > p.toBlock ? p.toBlock : from + chunk - 1n;
    const logs = await client.getLogs({ address: GUARDIAN.PERMISSION_MANAGER, event: approvedEvent, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const perm = l.args.permission;
      if (!perm || !isAddressEqual(perm.spender, p.keeper)) continue;
      if (perm.calls.length !== 3 || !perm.calls.every((c) => isAddressEqual(c.checker, p.checker))) continue;
      found.push({
        account: perm.account,
        spender: perm.spender,
        start: Number(perm.start),
        end: Number(perm.end),
        salt: perm.salt,
        calls: perm.calls.map((c) => ({ target: c.target, selector: c.selector, checker: c.checker })),
        spends: perm.spends.map((s) => ({ token: s.token, allowance: s.allowance, unit: Number(s.unit), multiplier: Number(s.multiplier) })),
      });
    }
  }
  return found;
}

export type AccountResult =
  | { account: Address; status: "skipped"; why: "revoked-or-unapproved" | "expired" }
  | { account: Address; status: "checked"; decision: GuardianDecision }
  | { account: Address; status: "repaid"; decision: GuardianDecision; amountRaw: bigint; txHash: `0x${string}` }
  | { account: Address; status: "would-repay"; decision: GuardianDecision; amountRaw: bigint }
  | { account: Address; status: "error"; error: string };

/** Read the position, plan, simulate and (unless dry-run) execute one rescue. */
export async function checkAccount(
  client: Reader,
  wallet: Signer | null,
  perm: GuardianPermission,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<AccountResult> {
  const account = perm.account;
  try {
    const now = opts.now ?? new Date();
    const tuple = toTuple(perm);
    // isApproved stays true after a revoke; revocation is tracked separately, so check both.
    const [approved, revoked] = await Promise.all([
      client.readContract({ address: GUARDIAN.PERMISSION_MANAGER, abi: permissionManagerAbi, functionName: "isApproved", args: [tuple] }),
      client.readContract({ address: GUARDIAN.PERMISSION_MANAGER, abi: permissionManagerAbi, functionName: "isRevoked", args: [tuple] }),
    ]);
    if (!approved || revoked) return { account, status: "skipped", why: "revoked-or-unapproved" };
    if (Math.floor(now.getTime() / 1000) >= perm.end) return { account, status: "skipped", why: "expired" };

    const [accountData, savingsRaw, period] = await Promise.all([
      client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [account] }),
      client.readContract({ address: GUARDIAN.AUSDC, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: GUARDIAN.PERMISSION_MANAGER, abi: permissionManagerAbi, functionName: "getCurrentPeriod", args: [tuple, tuple.spends[0]] }),
    ]);
    const s = summarize(accountData as AccountData);
    const cap = perm.spends[0].allowance;
    const capLeftRaw = cap > period.spend ? cap - period.spend : 0n;
    const decision = planGuardian({
      collateralUsd: s.collateralUsd,
      avgCf: s.avgCf,
      debtUsd: s.debtUsd,
      savingsUsd: Number(savingsRaw) / 10 ** USDC.decimals,
      capLeftUsd: Number(capLeftRaw) / 10 ** USDC.decimals,
      weekendWindow: inWeekendWindow(now),
    });
    if (decision.action !== "repay") return { account, status: "checked", decision };

    let amountRaw = BigInt(Math.ceil(decision.amountUsd * 10 ** USDC.decimals));
    if (amountRaw > savingsRaw) amountRaw = savingsRaw;
    if (amountRaw > capLeftRaw) amountRaw = capLeftRaw;
    const calls = buildRescueCalls(account, amountRaw);

    const sim = await client.simulateContract({
      address: GUARDIAN.PERMISSION_MANAGER,
      abi: permissionManagerAbi,
      functionName: "executeBatch",
      args: [tuple, calls],
      account: perm.spender,
    });
    if (opts.dryRun || !wallet) return { account, status: "would-repay", decision, amountRaw };
    const txHash = await wallet.writeContract(sim.request);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { account, status: "error", error: `reverted ${txHash}` };
    return { account, status: "repaid", decision, amountRaw, txHash };
  } catch (e) {
    return { account, status: "error", error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

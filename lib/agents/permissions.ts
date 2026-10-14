import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import type { PermissionsDetail } from "@jaw.id/wagmi";
import { AAVE } from "@/lib/aave/addresses";
import { GUARDIAN, SEL } from "@/lib/guardian/config";
import { PERIOD, type GuardianPermission } from "@/lib/guardian/permission";
import { USDC } from "@/lib/tokens/registry";

/** The agents' jobs, in GooseExecutor's order (enum Job): the index is the job's id on-chain. */
export const JOBS = ["save", "protect"] as const;
export type AgentJob = (typeof JOBS)[number];

/**
 * What each job may call, in the order of GooseExecutor's templates (`_permission`). JAW's screen grants every call
 * with checker 0 (D14), so the manager pins no argument: the executor builds each call for the account alone and
 * its post-checks revert anything else.
 */
const CALLS: Record<AgentJob, readonly { target: Address; selector: Hex }[]> = {
  save: [
    { target: USDC.address, selector: SEL.approve },
    { target: GUARDIAN.AAVE_V3_POOL, selector: SEL.supply },
  ],
  protect: [
    { target: GUARDIAN.AAVE_V3_POOL, selector: SEL.withdraw },
    { target: USDC.address, selector: SEL.approve },
    { target: AAVE.SPOKE, selector: SEL.repay },
  ],
};

/**
 * The tokens each job's daily limit covers, all at the same cap. Protect needs aUSDC as well as USDC: with checker 0,
 * a withdrawal of savings to someone else moves no USDC from the account, so a USDC limit alone would charge it
 * nothing (contracts/docs/MANAGER-NOTES.md §1).
 */
const LIMITED: Record<AgentJob, readonly Address[]> = {
  save: [USDC.address],
  protect: [USDC.address, GUARDIAN.AUSDC],
};

/**
 * The daily limit each job is switched on with: Protection's is the boards' "up to $300 a day" (HomeCreditSlide,
 * Agents). Save only moves the account's own USDC into its own savings, so its limit is wider. Both wait on the
 * calibration pass (plan item 6 step 9).
 */
export const DAILY_LIMIT_USD: Record<AgentJob, number> = { save: 1_000, protect: 300 };

/** A job's daily limit in USDC units, never above the executor's `CAP_MAX` (a D13 test deploy allows $5). */
export function dailyLimitRaw(job: AgentJob, capMaxRaw: bigint): bigint {
  const raw = BigInt(DAILY_LIMIT_USD[job]) * 10n ** BigInt(USDC.decimals);
  return raw < capMaxRaw ? raw : capMaxRaw;
}

/** What the app sends to JAW's `useGrantPermissions` to switch `job` on, with a daily limit in USDC units. */
export function agentGrant(job: AgentJob, capRaw: bigint): PermissionsDetail {
  if (capRaw <= 0n) throw new Error("Daily limit must be positive");
  return {
    calls: CALLS[job].map(({ target, selector }) => ({ target, selector })),
    spends: LIMITED[job].map((token) => ({ token, allowance: capRaw.toString(), unit: "day" })),
  };
}

/**
 * The permission JAW's grant puts on-chain for `agentGrant(job, capRaw)`: checker 0, Day × 1, and the start and salt
 * JAW's SDK picks (core rpc/permissions.js apiPermissionsToPermission). GooseExecutor rebuilds the same struct.
 */
export function agentPermission(
  job: AgentJob,
  p: { account: Address; spender: Address; start: number; end: number; salt: bigint; capRaw: bigint },
): GuardianPermission {
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: CALLS[job].map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: LIMITED[job].map((token) => ({ token, allowance: p.capRaw, unit: PERIOD.Day, multiplier: 1 })),
  };
}

/** A permission as JAW's `usePermissions` lists it (the relay's record). */
export type ListedPermission = {
  permissionId: string;
  spender: string;
  start: number;
  end: number;
  salt: string;
  calls: { target: string; selector: string; checker?: string }[];
  spends: { token: string; allowance: string; unit: string; multiplier: number }[];
};

export type AgentGrant = { job: AgentJob; permissionId: Hex; capRaw: bigint; start: number; end: number; salt: bigint };

/** Reads a listed permission as one of ours: the executor as spender and exactly one job's template. */
export function readAgentGrant(p: ListedPermission, executor: Address): AgentGrant | null {
  if (!isAddressEqual(p.spender as Address, executor) || p.spends.length === 0) return null;
  const capRaw = BigInt(p.spends[0].allowance);
  if (capRaw <= 0n) return null;
  const job = JOBS.find(
    (j) =>
      p.calls.length === CALLS[j].length &&
      CALLS[j].every(
        (c, i) =>
          isAddressEqual(p.calls[i].target as Address, c.target) &&
          p.calls[i].selector.toLowerCase() === c.selector &&
          (!p.calls[i].checker || isAddressEqual(p.calls[i].checker as Address, zeroAddress)),
      ) &&
      p.spends.length === LIMITED[j].length &&
      LIMITED[j].every(
        (token, i) =>
          isAddressEqual(p.spends[i].token as Address, token) &&
          p.spends[i].unit === "day" &&
          p.spends[i].multiplier === 1 &&
          BigInt(p.spends[i].allowance) === capRaw,
      ),
  );
  return job ? { job, permissionId: p.permissionId as Hex, capRaw, start: p.start, end: p.end, salt: BigInt(p.salt) } : null;
}

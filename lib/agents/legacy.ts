import { encodeAbiParameters, isAddress, isAddressEqual, isHex, zeroAddress, type Address, type Hex } from "viem";
import { PERIOD_WORD } from "@/lib/agents/agentJob";
import type { JawPermission, ListedPermission } from "@/lib/agents/permissions";
import { permissionTuple } from "@/lib/protocols/abis";

/*
 * GG-05 (Mariano, round 2): main's agents ran on GooseExecutor, and their JAW grants (spender the executor, no amount
 * limit, a year long) stay approved in JAW's manager after the app moves to GooseGuard. The Guard's app never lists them
 * as agents (readAgentGrant only reads grants to the Guard), so nothing would take them back. The app finds them on
 * Base and in JAW's list, and revokes every one still approved in the same batch the user signs to switch agents on or
 * off (useAgents `changePlan`), through the same manager.revoke the account sends for a grant a new one replaces.
 */

/**
 * GooseExecutor, the spender of every agent grant on main. A fixed address, never read from env: env names the Guard,
 * and this is the one contract the app must still find grants to after the move.
 */
export const LEGACY_EXECUTOR = "0x686cd88F248DE3F9FC0835566DB798D93881F02D" as const;

/** GooseExecutor's `permissionOf(account, job)` (main lib/agents/abis/GooseExecutor.ts): the grant it holds per job. */
export const legacyExecutorAbi = [
  {
    type: "function",
    name: "permissionOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "job", type: "uint8" },
    ],
    outputs: [permissionTuple],
  },
] as const;

/** GooseExecutor's jobs (save, protect, sell, rebalance, entry): the ids `permissionOf` is read with. */
export const LEGACY_JOB_IDS = [0, 1, 2, 3, 4] as const;

/** A grant of `user`'s own to GooseExecutor: the one kind of grant besides the Guard's the app may revoke. */
export function isLegacyGrant(p: unknown, user: Address): boolean {
  if (!p || typeof p !== "object") return false;
  const { account, spender } = p as Partial<JawPermission>;
  try {
    return !!account && !!spender && isAddressEqual(account, user) && isAddressEqual(spender, LEGACY_EXECUTOR);
  } catch {
    return false;
  }
}

/** JustaPermissionManager's PeriodUnit for each word JAW's relay lists a spend with (PERIOD_WORD, reversed). */
const UNIT_OF: Record<string, number> = Object.fromEntries(
  Object.entries(PERIOD_WORD).map(([unit, word]) => [word, Number(unit)]),
);

/**
 * A listed record as the struct the manager approved, for `account`: any template (main's grants had caps and other
 * calls than today's), checker 0 where the record names none. Null for a record that can't be one.
 */
export function listedToPermission(p: ListedPermission, account: Address): JawPermission | null {
  try {
    const addr = (a: string | undefined) => {
      const v = a ?? zeroAddress;
      if (!isAddress(v)) throw new Error("not an address");
      return v as Address;
    };
    const spends = p.spends.map((s) => {
      const unit = UNIT_OF[s.unit];
      if (unit === undefined) throw new Error("no such period");
      return { token: addr(s.token), allowance: BigInt(s.allowance), unit, multiplier: s.multiplier };
    });
    const calls = p.calls.map((c) => {
      if (!isHex(c.selector) || c.selector.length !== 10) throw new Error("not a selector");
      return { target: addr(c.target), selector: c.selector as Hex, checker: addr(c.checker) };
    });
    return { account, spender: addr(p.spender), start: p.start, end: p.end, salt: BigInt(p.salt), calls, spends };
  } catch {
    return null;
  }
}

/** A grant to GooseExecutor that may still be approved, not yet checked on Base. */
export type LegacyCandidate = { p: JawPermission; key: string };

/** The struct as the manager hashes it (abi.encode), so one grant read twice counts once. */
const keyOf = (p: JawPermission) => encodeAbiParameters([permissionTuple], [p]).toLowerCase();

/**
 * The grants to GooseExecutor `account` may still hold, once each: the ones the executor keeps (`permissionOf`, a job
 * that never had one reads with end 0) and the ones JAW lists, still in their year at `nowSec`.
 */
export function legacyCandidates(
  account: Address,
  listed: readonly ListedPermission[],
  registry: readonly JawPermission[],
  nowSec: number,
): LegacyCandidate[] {
  const out: LegacyCandidate[] = [];
  const add = (p: JawPermission | null) => {
    if (!p || !isLegacyGrant(p, account) || p.end === 0 || p.end < nowSec) return;
    const key = keyOf(p);
    if (!out.some((c) => c.key === key)) out.push({ p, key });
  };
  for (const p of registry) add(p);
  for (const r of listed) {
    try {
      if (isAddressEqual(r.spender as Address, LEGACY_EXECUTOR)) add(listedToPermission(r, account));
    } catch {
      // a record with no address for its spender: not one of these
    }
  }
  return out;
}

/** What the manager says of one struct: its id (the manager's hash) and whether it's approved and revoked. */
export type LegacyRead = { id: Hex; approved: boolean; revoked: boolean };

/** The candidates the manager has approved and not revoked: what a change revokes, each with its id. */
export function legacyToRevoke(
  candidates: readonly LegacyCandidate[],
  reads: readonly (LegacyRead | undefined)[],
): { id: Hex; p: JawPermission }[] {
  return candidates.flatMap((c, k) => {
    const r = reads[k];
    return r && r.approved && !r.revoked ? [{ id: r.id, p: c.p }] : [];
  });
}

/** What the page knows of the grants to GooseExecutor: whether Base answered for all of them, and those still live. */
export type LegacyState = { known: boolean; unreadable: boolean; revokes: readonly { id: Hex; p: JawPermission }[] };

/**
 * The grants to GooseExecutor a change revokes: all still approved, in any change that grants or turns off a job, and
 * none in one that only changes settings. A change that grants waits ("wait") until Base has answered for all of them,
 * or says why it can't go ahead ("unreadable"): a new grant never goes ahead with an old one possibly left approved. A
 * turn-off never waits on them.
 */
export function legacyRevokesFor(
  state: LegacyState,
  change: { granting: boolean; changingJobs: boolean },
): "wait" | "unreadable" | { id: Hex; p: JawPermission }[] {
  if (change.granting && !state.known) return state.unreadable ? "unreadable" : "wait";
  return change.changingJobs ? [...state.revokes] : [];
}

import { JOBS, type AgentGrant, type AgentJob } from "@/lib/agents/permissions";

/**
 * - "unconfigured": no executor is set (NEXT_PUBLIC_GOOSE_EXECUTOR), so no agent can be switched on yet.
 * - "starting": a grant JAW lists that the executor hasn't registered: one granted on JAW's own sheet before grants
 *   became one signature (D14, dropped 2026-10-20). Its sheet's Finish registers it (useAgents `finishPlan`).
 * - "on": the executor runs it: registered, not past its end, and not revoked in the manager.
 */
export type AgentStatus = "unconfigured" | "loading" | "off" | "starting" | "on";

/**
 * JAW sheets a change's grants take: one batch with every grant's approve and registration and the change's registry
 * settings (Adrian, 2026-10-20: "the permission, the cash move and the registration in one signature").
 */
export const changeSheets = (grants: number) => (grants > 0 ? 1 : 0);

/**
 * A change's last batch that stopped before JAW signed it, in the app's own words (its simulation's reason, a batch that
 * failed on Base, an account that can't send it in one go): said as it is, not as a generic failure.
 */
export class AgentStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStop";
  }
}

/** A job's grant as the executor stores it: what the user signed that its template doesn't fix. */
export type Stored = { start: number; end: number; cap: bigint };

/**
 * Whether the executor runs `job`: registered (its bit in `jobs`, GooseExecutor.jobsOf), not past its end, and not
 * revoked in the manager (`revoked`, read on Base, where a revoke shows at once; the registry only learns of it on the
 * next run). A one-signature grant reaches JAW's list after its batch, so the list doesn't decide. Until the manager is
 * read (`revoked` undefined), that same grant still in JAW's list stands for it, or the registry alone if the list
 * can't be read either.
 */
export function jobStatus(
  job: AgentJob,
  jobs: number,
  stored: Stored,
  granted: readonly AgentGrant[],
  nowSec: number,
  listUnreadable: boolean,
  revoked?: boolean,
): Exclude<AgentStatus, "unconfigured" | "loading"> {
  const live = granted.filter((g) => g.job === job && g.end >= nowSec);
  const registered = (jobs & (1 << JOBS.indexOf(job))) !== 0 && stored.end >= nowSec;
  const stillGranted =
    revoked === undefined
      ? listUnreadable ||
        live.some((g) => g.start === stored.start && g.end === stored.end && g.capRaw === stored.cap)
      : !revoked;
  if (registered && stillGranted) return "on";
  return live.length > 0 ? "starting" : "off";
}

/**
 * Said when a job shows on but the list of what the account has switched on can't be read, so there's nothing known
 * to revoke: turning it off can't go ahead, and saying nothing would leave the agent running while the screen moved on.
 */
export const OFF_UNREADABLE = "We couldn’t check what’s switched on right now, so nothing was turned off. Try again.";

/**
 * Turning `jobs` off: one revoke step for each job with a grant to revoke (`faceIds`, one JAW sheet each), or, when the
 * list can't be read and a job still shows on or starting, no steps and OFF_UNREADABLE. A job already off needs none.
 * `on`: something shows on, so a "turn off" control stays (it says OFF_UNREADABLE when it can't go ahead).
 */
export function offSteps(
  jobs: readonly AgentJob[],
  statusOf: (job: AgentJob) => AgentStatus,
  faceIds: (job: AgentJob) => number,
  listUnreadable: boolean,
): { steps: { off: AgentJob }[]; error: string | null; on: boolean } {
  const stuck = jobs.some((j) => offUnreadable(statusOf(j), faceIds(j), listUnreadable));
  if (stuck) return { steps: [], error: OFF_UNREADABLE, on: true };
  const steps = jobs.filter((j) => faceIds(j) > 0).map((j) => ({ off: j }));
  return { steps, error: null, on: steps.length > 0 };
}

/** A job that shows on or starting, with nothing known to revoke because the list can't be read. */
export const offUnreadable = (status: AgentStatus, toRevoke: number, listUnreadable: boolean) =>
  listUnreadable && toRevoke === 0 && (status === "on" || status === "starting");

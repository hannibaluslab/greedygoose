import { JOBS, type AgentGrant, type AgentJob } from "@/lib/agents/permissions";

/**
 * - "unconfigured": no executor is set (NEXT_PUBLIC_GOOSE_EXECUTOR), so no agent can be switched on yet.
 * - "starting": JAW granted it and the executor hasn't registered it yet (its log-trigger upkeep does that).
 * - "on": the executor runs it with a grant JAW still lists.
 */
export type AgentStatus = "unconfigured" | "loading" | "off" | "starting" | "on";

/** A job's grant as the executor stores it: what the user signed that its template doesn't fix. */
export type Stored = { start: number; end: number; cap: bigint };

/**
 * Whether the executor runs `job`: registered (its bit in `jobs`, GooseExecutor.jobsOf), not past its end, and with
 * that same grant still in JAW's list, where a revoke shows at once (the registry only learns of it on the next run).
 * If JAW's list can't be read, the registry alone decides.
 */
export function jobStatus(
  job: AgentJob,
  jobs: number,
  stored: Stored,
  granted: readonly AgentGrant[],
  nowSec: number,
  listUnreadable: boolean,
): Exclude<AgentStatus, "unconfigured" | "loading"> {
  const live = granted.filter((g) => g.job === job && g.end >= nowSec);
  const registered = (jobs & (1 << JOBS.indexOf(job))) !== 0 && stored.end >= nowSec;
  const stillGranted =
    listUnreadable || live.some((g) => g.start === stored.start && g.end === stored.end && g.capRaw === stored.cap);
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

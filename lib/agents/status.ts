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

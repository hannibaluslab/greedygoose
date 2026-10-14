import { EXECUTOR_JOBS, type AgentGrant, type ExecutorJob } from "@/lib/agents/permissions";

/**
 * - "unconfigured": no executor is set (NEXT_PUBLIC_GOOSE_EXECUTOR), so no agent can be switched on yet.
 * - "starting": JAW granted it and the executor hasn't registered it yet (its log-trigger upkeep does that).
 * - "on": the executor runs it with a grant JAW still lists.
 */
export type AgentStatus = "unconfigured" | "loading" | "off" | "starting" | "on";

type Stored = { start: number; end: number; cap: bigint };

/** What GooseExecutor's registry holds for one account: the job bits, and each job's stored grant (`permissionOf`). */
export type Registry = { jobs: number; grants: Readonly<Record<ExecutorJob, Stored>> };

/**
 * Whether the executor runs `job`: registered, not past its end, and with that same grant still in JAW's list,
 * where a revoke shows at once (the registry only learns of it on the next run). If JAW's list can't be read, the
 * registry alone decides.
 */
export function jobStatus(
  job: ExecutorJob,
  registry: Registry,
  granted: readonly AgentGrant[],
  nowSec: number,
  listUnreadable: boolean,
): Exclude<AgentStatus, "unconfigured" | "loading"> {
  const stored = registry.grants[job];
  const live = granted.filter((g) => g.job === job && g.end >= nowSec);
  const registered = (registry.jobs & (1 << EXECUTOR_JOBS.indexOf(job))) !== 0 && stored.end >= nowSec;
  const stillGranted =
    listUnreadable || live.some((g) => g.start === stored.start && g.end === stored.end && g.capRaw === stored.cap);
  if (registered && stillGranted) return "on";
  return live.length > 0 ? "starting" : "off";
}

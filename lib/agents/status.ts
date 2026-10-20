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

/** A job's grant as the executor stores it: what the user signed that its template doesn't fix. */
export type Stored = { start: number; end: number; cap: bigint };

/**
 * Whether the executor runs `job`: registered (its bit in `jobs`, GooseExecutor.accounts), not past its end, and alive
 * (`alive`, read on Base: not revoked in the manager, where a revoke shows at once while the registry only learns of
 * it on the next run, and the manager still an owner of the account). A one-signature grant reaches JAW's list after
 * its batch, so the list doesn't decide. Without that read (`alive` undefined), that same grant still in JAW's list
 * stands for it, or the registry alone if the list can't be read either.
 */
export function jobStatus(
  job: AgentJob,
  jobs: number,
  stored: Stored,
  granted: readonly AgentGrant[],
  nowSec: number,
  listUnreadable: boolean,
  alive?: boolean,
): Exclude<AgentStatus, "unconfigured" | "loading"> {
  const live = granted.filter((g) => g.job === job && g.end >= nowSec);
  const isStored = (g: AgentGrant) => g.start === stored.start && g.end === stored.end && g.capRaw === stored.cap;
  const registered = (jobs & (1 << JOBS.indexOf(job))) !== 0 && stored.end >= nowSec;
  const stillGranted = alive === undefined ? listUnreadable || live.some(isStored) : alive;
  if (registered && stillGranted) return "on";
  // The grant the executor switched off (or that was revoked) isn't one waiting to start: only a newer one is.
  return live.some((g) => !isStored(g)) ? "starting" : "off";
}

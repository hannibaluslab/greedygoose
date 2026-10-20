import { grantPick } from "@/lib/agents/oneTapGrant";
import type { AgentJob } from "@/lib/agents/permissions";

/*
 * A one-signature grant's start and salt are picked by the app before its batch (lib/agents/oneTapGrant.ts `grantPick`),
 * so the registration in the same batch can carry them. A change's batch is prepared while its sheet shows (useTx), and
 * its key names the salts, so a pick has to hold from render to render: one per account, job and terms (which name the
 * grant the executor holds too, so a new one there means a new pick), kept here for every screen.
 */

type Pick = { start: number; salt: bigint };
const picks = new Map<string, Pick>();

/**
 * A new grant starts this far behind the device's clock, so a phone a few minutes fast doesn't replace a running grant
 * with one that can't run yet (the executor skips a grant before its start).
 */
const START_BEHIND_SEC = 300;
/** A pick older than this is picked again: a grant signed later still runs a year from about then. */
const PICK_FRESH_SEC = 600;

/**
 * The start and salt for `job`'s grant on `terms`: the one picked in the last ten minutes, else a new one (a prepared
 * batch is re-checked every 15 s, so a new pick only means one more check). Its start is never under
 * `minStart` (one past the start of the grant the executor holds: GooseExecutor's `_isNewer` refuses an older one with
 * StaleGrant, and an equal one could be swapped back and forth).
 */
export function pickFor(account: string, job: AgentJob, terms: string, minStart: number, nowMs = Date.now()): Pick {
  const key = `${account.toLowerCase()}:${job}:${terms}`;
  const had = picks.get(key);
  const nowSec = Math.floor(nowMs / 1000);
  if (had && had.start >= minStart && nowSec - had.start <= START_BEHIND_SEC + PICK_FRESH_SEC) return had;
  const fresh = grantPick(nowMs);
  const pick = { start: Math.max(fresh.start - START_BEHIND_SEC, minStart), salt: fresh.salt };
  picks.set(key, pick);
  return pick;
}

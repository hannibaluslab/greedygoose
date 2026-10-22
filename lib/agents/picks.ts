import { grantPick } from "@/lib/agents/oneTapGrant";
import type { AgentJob } from "@/lib/agents/permissions";

/*
 * A one-signature grant's start and salt are picked by the app before its batch (lib/agents/oneTapGrant.ts `grantPick`),
 * so the registration in the same batch can carry them. A change's batch is prepared while its sheet shows (useTx), and
 * its key names the salts, so a pick has to hold from render to render: one per account, job and terms (which name the
 * grant GooseGuard holds too, so a new one there means a new pick), kept here for every screen.
 */

type Pick = { start: number; salt: bigint };
const picks = new Map<string, Pick>();

/**
 * A new grant starts this far behind the earlier of the device's clock and Base's latest block: GooseGuard refuses a
 * grant whose start is after the block it lands in (FutureStart), so a phone a few minutes fast never builds a batch
 * that reverts.
 */
const START_BEHIND_SEC = 300;
/** A pick older than this is picked again: a grant signed later still runs a year from about then. */
const PICK_FRESH_SEC = 600;

/**
 * The start and salt for `job`'s grant on `terms`: the one picked in the last ten minutes, else a new one (a prepared
 * batch is re-checked every 15 s, so a new pick only means one more check). Its start is
 * `max(minStart, min(device clock, chain head) − 300)`, where `minStart` is one past the start of the grant GooseGuard
 * holds for the job (word 3 of `permissionOf`: its high-water mark, which refuses an older or equal start with
 * StaleGrant) and `headSec` the timestamp of Base's latest block.
 */
export function pickFor(
  account: string,
  job: AgentJob,
  terms: string,
  minStart: number,
  headSec: number,
  nowMs = Date.now(),
): Pick {
  const key = `${account.toLowerCase()}:${job}:${terms}`;
  const had = picks.get(key);
  const nowSec = Math.min(Math.floor(nowMs / 1000), headSec);
  if (had && had.start >= minStart && nowSec - had.start <= START_BEHIND_SEC + PICK_FRESH_SEC) return had;
  const fresh = grantPick(nowSec * 1000);
  const pick = { start: Math.max(fresh.start - START_BEHIND_SEC, minStart), salt: fresh.salt };
  picks.set(key, pick);
  return pick;
}

/**
 * All-time profit and loss (Adrian, 2026-10-19), realized and unrealized in one sum: what the account is worth now
 * (cash + stocks at Aave's price − credit owed), plus what was taken out, less what was put in. Money someone sent, a
 * top-up and other dollars turned into cash are put in; a send is taken out; none of them is profit. What the stocks
 * did, the yield earned and what credit cost are. The % is that gain over the average money in (Modified Dietz): each
 * flow counts for the share of the time it was in, so money added yesterday doesn't dilute a month of gains.
 */

/** Money into (+) or out of (−) the account, in dollars, at unix second `t`. */
export type Flow = { t: number; usd: number };

/** The account's worth at the end of a day (unix second `t`): cash + stocks at Aave's price − credit owed. */
export type WorthPoint = { t: number; worthUsd: number };

type Pnl = {
  /** Worth now + taken out − put in. */
  gainUsd: number;
  /** gain ÷ average money in, or null when there's nothing to divide by. */
  pct: number | null;
  /** Since when (unix seconds): the first money in. */
  sinceSec: number;
};

/** All time, from the first money in to `nowSec`. Null before any money came in. */
export function pnlAllTime(worthNowUsd: number, flows: readonly Flow[], nowSec: number): Pnl | null {
  const sorted = [...flows].sort((a, b) => a.t - b.t);
  const first = sorted.find((f) => f.usd > 0);
  if (!first) return null;
  const net = sorted.reduce((a, f) => a + f.usd, 0);
  const gainUsd = worthNowUsd - net;
  const span = nowSec - first.t;
  // Modified Dietz from a worth of 0 at the first money in: each flow weighted by the share of the period after it.
  const average =
    span > 0 ? sorted.reduce((a, f) => a + (f.usd * Math.max(0, nowSec - Math.max(f.t, first.t))) / span, 0) : net;
  return { gainUsd, pct: average > 0 ? gainUsd / average : null, sinceSec: first.t };
}

/**
 * The P&L line: at each day's end, the worth then less the money in up to then, from the first money in to now, so it
 * starts at $0 and ends on `pnlAllTime`'s gain. Days before the first money in are left out.
 */
export function pnlSeries(
  days: readonly WorthPoint[],
  flows: readonly Flow[],
  worthNowUsd: number,
  nowSec: number,
): number[] {
  const sorted = [...flows].sort((a, b) => a.t - b.t);
  const first = sorted.find((f) => f.usd > 0);
  if (!first) return [];
  const netBy = (t: number) => sorted.reduce((a, f) => (f.t <= t ? a + f.usd : a), 0);
  const points = [0];
  for (const d of [...days].sort((a, b) => a.t - b.t)) {
    if (d.t <= first.t || d.t >= nowSec) continue;
    points.push(d.worthUsd - netBy(d.t));
  }
  points.push(worthNowUsd - netBy(nowSec));
  return points;
}

/** The ends of the UTC days from the one `fromSec` falls in to the last one before `nowSec` (unix seconds). */
export function dayEnds(fromSec: number, nowSec: number): number[] {
  const DAY = 86_400;
  const out: number[] = [];
  for (let t = Math.floor(fromSec / DAY) * DAY + DAY - 1; t < nowSec; t += DAY) out.push(t);
  return out;
}

/** Base makes a block every 2 seconds: the block at unix second `t`, from the head and its time. */
export const blockAt = (t: number, head: bigint, headSec: number): bigint =>
  head - BigInt(Math.max(0, Math.ceil((headSec - t) / 2)));

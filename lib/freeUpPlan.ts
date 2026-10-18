import { CREDIT_CAP } from "@/config/risk";
import { statusFor, type Status } from "@/lib/risk/status";

/*
 * Repay + free up (canvas boards 1–8): the stocks ticked under "Also free up stocks", and how much of each comes out
 * of backing in the same signature as the repay. All of them share one limit: after the repay, the health stays at or
 * above CREDIT_CAP.minHf (1.12, "Act is the line"), so stock taken out is power the others can't use. Amounts are a
 * share of the shares held (25%, 50%, Max, All). Pure, so it's unit-tested (tests/unit/free-up-plan.test.ts); the batch
 * is checked again on Aave's own health before JAW's sheet (FREE_UP_FLOOR).
 */

/** Under the limit by a hair when a stock comes out at its most, so a price tick before signing doesn't stop it. */
const AT_MOST_MARGIN = 0.995;
const EPS = 1e-9;

export type FreeUpStock = {
  symbol: string;
  /** The shares that back credit, raw, and their value at Aave's price. */
  backingRaw: bigint;
  backingUsd: number;
  /** The stock's collateral factor, 0–1. */
  cf: number;
  /** Aave has paused it: it can't come out. */
  paused: boolean;
};

/** A ticked stock and how much of it to take out: a share of the shares held, 1 for all of them. */
type FreeUpPick = { symbol: string; share: number };

type FreeUpRow = {
  symbol: string;
  paused: boolean;
  picked: boolean;
  /** The most this stock can free right now, given the other ticked stocks: a share of the shares held, 0–1. */
  maxShare: number;
  /** All of it fits under the limit. */
  canAll: boolean;
  /** When it doesn't: the extra repay, in whole dollars, that lets all of it out ("+$75 repay"). */
  allNeedsUsd: number;
  /** What comes out (ticked stocks only): the share shown, the dollars at Aave's price and the raw shares to sign. */
  share: number;
  usd: number;
  raw: bigint;
  /** Every share comes out (the withdraw signs "all"). */
  all: boolean;
};

type FreeUpPlan = {
  rows: FreeUpRow[];
  /** How much of the limit the ticked stocks use, 0–1 (the "Free-up limit" bar). */
  used: number;
  /** Owed after the repay. */
  owedAfterUsd: number;
  hfAfter: number | null;
  after: Status;
  /** It ends in Watch: the "I understand" tick. */
  risky: boolean;
  /** Credit available once the repay and the take-outs land, floored to the dollar. */
  creditAfterUsd: number;
  /** What to sign: the ticked stocks with something to take out. */
  frees: { symbol: string; raw: bigint; all: boolean }[];
};

const dollarsUp = (usd: number) => Math.ceil(usd - 1e-6);

/**
 * The free-up list for a repay. Ticked stocks take their share in the order they were ticked: each can use what the
 * stocks before it left of the limit, so ticking one makes the others' "Up to" shrink. A repay that pays everything
 * leaves nothing owed, so every stock can come out.
 */
export function planFreeUp(p: {
  position: { totalBackingUsd: number; avgCf: number; debtUsd: number };
  /** The repay in the same signature, in dollars, and whether it pays everything owed. */
  repayUsd: number;
  repaysAll: boolean;
  /** Power that leaves with the repay itself: a stock that backs credit, sold to pay (its dollars × its factor). */
  repayPowerOutUsd?: number;
  stocks: readonly FreeUpStock[];
  picks: readonly FreeUpPick[];
}): FreeUpPlan {
  const m = CREDIT_CAP.minHf;
  const power = Math.max(0, p.position.totalBackingUsd * p.position.avgCf - (p.repayPowerOutUsd ?? 0));
  const owedAfterUsd = p.repaysAll ? 0 : Math.max(0, p.position.debtUsd - p.repayUsd);
  const limit = owedAfterUsd <= 0 ? Infinity : Math.max(0, power - owedAfterUsd * m);

  const bySymbol = new Map(p.stocks.map((s) => [s.symbol, s]));
  const picks = p.picks.filter((k) => {
    const s = bySymbol.get(k.symbol);
    return s && !s.paused && s.backingUsd > 0 && k.share > 0;
  });

  // Ticked stocks in tick order: each takes its share, held to what the ones before it left.
  const taken = new Map<string, { share: number; usd: number; maxShare: number }>();
  let used = 0;
  for (const k of picks) {
    const s = bySymbol.get(k.symbol)!;
    const maxShare = Math.min(1, Math.max(0, (limit - used) / s.cf / s.backingUsd));
    const share = Math.min(k.share, maxShare);
    taken.set(k.symbol, { share, usd: share * s.backingUsd, maxShare });
    used += share * s.backingUsd * s.cf;
  }

  const rows: FreeUpRow[] = p.stocks.map((s) => {
    const mine = taken.get(s.symbol);
    const others = used - (mine ? mine.usd * s.cf : 0);
    const maxShare =
      s.paused || s.backingUsd <= 0 ? 0 : Math.min(1, Math.max(0, (limit - others) / s.cf / s.backingUsd));
    const canAll = !s.paused && maxShare >= 1 - EPS;
    // The repay that would let all of it out: what's owed after it has to fit under the power the rest leaves.
    const left = power - others - s.backingUsd * s.cf;
    const allNeedsUsd =
      canAll || s.paused ? 0 : left <= 0 ? dollarsUp(owedAfterUsd) : dollarsUp(owedAfterUsd - left / m);
    const share = mine?.share ?? 0;
    const all = !!mine && share >= 1 - EPS;
    const atMost = !!mine && share >= maxShare - EPS;
    const raw = !mine
      ? 0n
      : all
        ? s.backingRaw
        : (s.backingRaw * BigInt(Math.floor(share * (atMost ? AT_MOST_MARGIN : 1) * 1_000_000))) / 1_000_000n;
    return {
      symbol: s.symbol,
      paused: s.paused,
      picked: !!mine,
      maxShare,
      canAll,
      allNeedsUsd: Math.max(0, allNeedsUsd),
      share,
      usd: mine?.usd ?? 0,
      raw,
      all,
    };
  });

  const out = power - used;
  const hfAfter = owedAfterUsd <= 0 ? null : out / owedAfterUsd;
  const after = statusFor(hfAfter);
  return {
    rows,
    used: limit === Infinity ? (used > 0 ? 1 : 0) : limit > 0 ? Math.min(1, used / limit) : 1,
    owedAfterUsd,
    hfAfter,
    after,
    risky: after === "watch",
    creditAfterUsd: Math.max(0, Math.floor(out / m - owedAfterUsd + 1e-6)),
    frees: rows.filter((r) => r.picked && r.raw > 0n).map((r) => ({ symbol: r.symbol, raw: r.raw, all: r.all })),
  };
}

/** Repay all: every stock comes back, so every one that backs credit is taken out in full. */
export const freeAll = (stocks: readonly FreeUpStock[]): FreeUpPick[] =>
  stocks.filter((s) => !s.paused && s.backingRaw > 0n).map((s) => ({ symbol: s.symbol, share: 1 }));

import { CREDIT_CAP, RISK } from "@/config/risk";

/** One stock the user is locking in a combined loan, valued at Aave's price. */
export type BackingLine = { key: string; usd: number; cf: number; freeUsd: number };

/**
 * Combined loan: lock several stocks (any amounts) and borrow, in one go.
 * Power = what Aave lets you borrow = existing weighted collateral + Σ lock × cf.
 */
export function combinedCredit(p: {
  totalBackingUsd: number;
  avgCf: number;
  debtUsd: number;
  lines: BackingLine[];
  creditUsd: number;
  liquidityUsd: number;
  /** The app's cap (config/risk.ts CreditLine), CREDIT_CAP.minHf unless the position says otherwise. */
  capHf?: number;
}) {
  const power = p.totalBackingUsd * p.avgCf + p.lines.reduce((a, l) => a + l.usd * l.cf, 0);
  const debtAfter = p.debtUsd + p.creditUsd;
  const hfAfter = debtAfter > 0 ? power / debtAfter : Infinity;
  const upTo = (target: number) => Math.max(0, Math.min(power / target - p.debtUsd, p.liquidityUsd));
  return {
    powerUsd: power,
    hfAfter,
    /** Most you can borrow with these locks and still be Safe. */
    maxSafe: upTo(RISK.safeMin),
    /** Most you can borrow before the loan reaches Act (the Watch line). */
    maxWatch: upTo(RISK.watchMin),
    /**
     * The most credit the app takes with these locks: health stays at or above the line's cap, CREDIT_CAP.minHf (Act is
     * the line, Adrian 2026-10-15) or, once Greedy Fatalities is open, nearer Aave's line (config/risk.ts
     * creditLineFor). Every way of taking credit is capped here (lib/creditBuy.ts creditCap).
     */
    maxCredit: upTo(p.capHf ?? CREDIT_CAP.minHf),
    /** Aave's own limit with these locks (HF = 1). Never borrow right up to it. */
    maxAave: upTo(1),
  };
}

/** Margin on auto-filled backing, so a price tick between reading and signing can't undercut Safe. */
export const FILL_MARGIN = 1.003;

/** Parts the fill's share of a free balance is counted in: fine enough that a small fill out of a large holding keeps its margin. */
const FILL_PARTS = 1_000_000_000_000;

/**
 * Raw units of a free balance for `usd` of it plus FILL_MARGIN; never more than the balance, and 99.99% or more rounds
 * up to all of it. The share is rounded up, in parts per 10^12: in parts per million, $9.62 out of $382,000 of Apple
 * rounded down to $9.55, more than the margin, and the plan ended in Watch instead of Safe.
 */
export function fillRaw(freeRaw: bigint, freeUsd: number, usd: number): bigint {
  if (usd <= 0 || freeUsd <= 0) return 0n;
  const f = Math.min(1, (usd * FILL_MARGIN) / freeUsd);
  if (f >= 0.9999) return freeRaw;
  const raw = (freeRaw * BigInt(Math.ceil(f * FILL_PARTS))) / BigInt(FILL_PARTS);
  return raw < freeRaw ? raw : freeRaw;
}

/**
 * Fill locks so `creditUsd` starts at `targetHf`, keeping what the user already chose and
 * topping up from the stocks with the highest collateral factor first.
 * Returns a usd amount per key (never above that stock's free value).
 */
export function autoFill(p: {
  totalBackingUsd: number;
  avgCf: number;
  debtUsd: number;
  creditUsd: number;
  lines: BackingLine[];
  targetHf?: number;
}): Record<string, number> {
  const target = Math.max(1, p.targetHf ?? RISK.safeMin);
  const out: Record<string, number> = Object.fromEntries(p.lines.map((l) => [l.key, l.usd]));
  let need =
    target * (p.debtUsd + p.creditUsd) - p.totalBackingUsd * p.avgCf - p.lines.reduce((a, l) => a + l.usd * l.cf, 0);
  for (const l of [...p.lines].sort((a, b) => b.cf - a.cf)) {
    if (need <= 0) break;
    if (l.cf <= 0) continue;
    const add = Math.min(l.freeUsd - out[l.key], need / l.cf);
    if (add <= 0) continue;
    out[l.key] += add;
    need -= add * l.cf;
  }
  return out;
}

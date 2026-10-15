import { CREDIT_CAP, RISK } from "@/config/risk";

/**
 * "Get a loan" planner: given how much USDC the user wants and which stock backs it,
 * work out how much of that stock to lock so the position starts at `targetHf`
 * (default: the Safe line). Uses the position's current weighted collateral factor for
 * what's already locked and the stock's own factor for the new lock. Display/plan only —
 * Aave re-checks everything on-chain and the batch is simulated before signing.
 */
export type LoanInput = {
  borrowUsd: number;
  /** Current position. */
  collateralUsd: number;
  avgCf: number;
  debtUsd: number;
  /** Backing stock. */
  priceUsd: number;
  cf: number;
  freeUsd: number;
  /** Health factor to start at (≥ 1). */
  targetHf?: number;
  /** USDC Aave can lend right now. */
  liquidityUsd: number;
};

export type LoanPlan = {
  /** USD of the backing stock to lock (0 = existing collateral is enough). */
  lockUsd: number;
  /** Fraction of the free balance to lock, 0–1. */
  lockFraction: number;
  /** Health factor after lock + borrow. */
  hfAfter: number;
  /** Largest borrow possible at the target health using all free stock + existing collateral. */
  maxBorrowUsd: number;
  feasible: boolean;
  reason?: "too-much" | "no-liquidity" | "no-collateral";
};

export function planLoan(i: LoanInput): LoanPlan {
  const target = Math.max(1, i.targetHf ?? RISK.safeMin);
  const existingPower = i.collateralUsd * i.avgCf;
  const freePower = i.freeUsd * i.cf;
  const maxBorrowUsd = Math.max(0, Math.min((existingPower + freePower) / target - i.debtUsd, i.liquidityUsd));

  const needPower = target * (i.debtUsd + i.borrowUsd) - existingPower;
  const lockUsd = i.cf > 0 ? Math.max(0, needPower / i.cf) : needPower > 0 ? Infinity : 0;
  const capped = Math.min(lockUsd, i.freeUsd);
  const debtAfter = i.debtUsd + i.borrowUsd;
  const hfAfter = debtAfter > 0 ? (existingPower + capped * i.cf) / debtAfter : Infinity;

  let reason: LoanPlan["reason"];
  if (i.borrowUsd > i.liquidityUsd) reason = "no-liquidity";
  else if (existingPower + freePower <= 0) reason = "no-collateral";
  else if (lockUsd > i.freeUsd + 1e-9) reason = "too-much";

  return {
    lockUsd: Number.isFinite(capped) ? capped : 0,
    lockFraction: i.freeUsd > 0 ? Math.min(1, capped / i.freeUsd) : 0,
    hfAfter,
    maxBorrowUsd,
    feasible: i.borrowUsd > 0 && !reason,
    reason,
  };
}

/** One stock the user is locking in a combined loan, valued at Aave's price. */
export type LockLine = { key: string; usd: number; cf: number; freeUsd: number };

/**
 * Combined loan: lock several stocks (any amounts) and borrow, in one go.
 * Power = what Aave lets you borrow = existing weighted collateral + Σ lock × cf.
 */
export function combinedLoan(p: { collateralUsd: number; avgCf: number; debtUsd: number; locks: LockLine[]; borrowUsd: number; liquidityUsd: number }) {
  const power = p.collateralUsd * p.avgCf + p.locks.reduce((a, l) => a + l.usd * l.cf, 0);
  const debtAfter = p.debtUsd + p.borrowUsd;
  const hfAfter = debtAfter > 0 ? power / debtAfter : Infinity;
  const room = (target: number) => Math.max(0, Math.min(power / target - p.debtUsd, p.liquidityUsd));
  return {
    powerUsd: power,
    hfAfter,
    /** Most you can borrow with these locks and still be Safe. */
    maxSafe: room(RISK.safeMin),
    /** Most you can borrow before the loan reaches Act (the Watch line). */
    maxWatch: room(RISK.watchMin),
    /**
     * The most credit the app takes with these locks (Act is the line, Adrian 2026-10-15): health stays at or above
     * CREDIT_CAP.minHf, the Act line plus its margin. Every way of taking credit is capped here (lib/creditBuy.ts creditCap).
     */
    maxCredit: room(CREDIT_CAP.minHf),
    /** Aave's own limit with these locks (HF = 1). Never borrow right up to it. */
    maxAave: room(1),
  };
}

/** Margin on auto-filled backing, so a price tick between reading and signing can't undercut Safe. */
export const FILL_MARGIN = 1.003;

/** Raw units of a free balance for `usd` of it plus FILL_MARGIN; never more than the balance, and 99.99% or more rounds up to all of it. */
export function fillRaw(freeRaw: bigint, freeUsd: number, usd: number): bigint {
  if (usd <= 0 || freeUsd <= 0) return 0n;
  const f = Math.min(1, (usd * FILL_MARGIN) / freeUsd);
  return f >= 0.9999 ? freeRaw : (freeRaw * BigInt(Math.round(f * 1_000_000))) / 1_000_000n;
}

/**
 * Fill locks so `borrowUsd` starts at `targetHf`, keeping what the user already chose and
 * topping up from the stocks with the highest collateral factor first.
 * Returns a usd amount per key (never above that stock's free value).
 */
export function autoFill(p: {
  collateralUsd: number;
  avgCf: number;
  debtUsd: number;
  borrowUsd: number;
  lines: LockLine[];
  targetHf?: number;
}): Record<string, number> {
  const target = Math.max(1, p.targetHf ?? RISK.safeMin);
  const out: Record<string, number> = Object.fromEntries(p.lines.map((l) => [l.key, l.usd]));
  let need = target * (p.debtUsd + p.borrowUsd) - p.collateralUsd * p.avgCf - p.lines.reduce((a, l) => a + l.usd * l.cf, 0);
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

/** The Repay screen's amounts (CreditOn): $100 and $300, as the board offers them. */
const REPAY_CHIPS = [100, 300];

/**
 * Whole-dollar amounts to offer next to "All": the board's $100 and $300 when both are below `maxUsd` (the most the
 * cash can repay), else a quarter and a half of it, so a small loan still gets two choices.
 */
export function repayChips(maxUsd: number): number[] {
  const fit = REPAY_CHIPS.filter((v) => v < maxUsd);
  const chips = fit.length === REPAY_CHIPS.length ? fit : [Math.floor(maxUsd / 4), Math.floor(maxUsd / 2)];
  return chips.filter((v, i, a) => v > 0 && v < maxUsd && a.indexOf(v) === i);
}

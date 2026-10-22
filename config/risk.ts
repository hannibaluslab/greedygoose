/**
 * Status bands over Aave's health factor (decision D2): the Safe / Watch / Act label and the extra-confirmation rule.
 * Since "Act is the line" (Adrian, 2026-10-15) they also set the app's own credit cap, CREDIT_CAP below.
 */
export type RiskBands = { safeMin: number; watchMin: number };

export const RISK: RiskBands = {
  /** Health factor at or above this is Safe. */
  safeMin: 1.5,
  /** Health factor at or above this (and below safeMin) is Watch; below is Act. */
  watchMin: 1.1,
};

/** Aave's own line: under a health factor of 1.0, Aave can sell part of the stocks that back credit to repay it. */
export const AAVE_LINE_HF = 1;

/**
 * Act is the line (Adrian, 2026-10-15: "watch is ok, it is act that is not"). Every way of taking credit may end in
 * Watch, never in Act, and Free up never ends in Act either. The most credit (and the most freed up) is what keeps the
 * health factor at or above `minHf`: the Act line plus `marginHf`, so one price update between reading the position
 * and signing can't land a plan taken at the cap in Act. This replaces D2's "the app does not add its own borrow cap
 * below Aave's" (it used 99.5% of Aave's limit, a health factor of about 1.005, deep in Act).
 *
 * Why 0.02: health moves with the backing's price, so 1.12 → 1.10 is a 1.8% fall (1 − 1.10 / 1.12). Measured on the
 * seven stocks' Chainlink feeds behind Aave's oracle on Base (3,666 updates, 2026-08-05 → 2026-10-15): an update fires
 * at about a 0.5% move; 99% of the falls between weekday updates were 0.80% or less and 99.9% were 1.10% or less. Two
 * were larger than 1.8%, both outside market hours (NVIDIA −1.87% on its earnings evening, Amazon −2.13% overnight);
 * the worst reopening after a weekend was −1.39%. Interest adds about 0.03% of the debt a day at 10% a year. Each 0.01
 * of margin costs about 0.9% of the credit at the cap; 1.13 would have covered every single update measured.
 */
const CAP_MARGIN_HF = 0.02;
export const CREDIT_CAP = {
  marginHf: CAP_MARGIN_HF,
  /** 1.12. Rounded to the hundredth so the cap's figures don't carry floating-point dust. */
  minHf: Math.round((RISK.watchMin + CAP_MARGIN_HF) * 100) / 100,
} as const;

/**
 * How low taking credit and freeing stock may take the health: the plans' cap (the MAX, "Up to", what a stock can
 * back) and the floor the batch's simulation is held to (lib/tx/prepared.ts HealthFloor).
 */
export type CreditLine = {
  capHf: number;
  stopHf: number;
  /** A plan may end in Act: the screen then shows the Wall's rule and asks for one tick. */
  intoAct: boolean;
};

/** Act is the line (2026-10-15): 1.12, the batch stopped in Act. The line until Greedy Fatalities opens. */
export const ACT_LINE: CreditLine = { capHf: CREDIT_CAP.minHf, stopHf: RISK.watchMin, intoAct: false };

/**
 * Down toward Aave's line (Adrian, 2026-10-21), once Greedy Fatalities is open (its rule is what a move into Act
 * confirms): with Protector on, 1.05, its line plus the same margin as 1.12 over Act, so Protector doesn't sell straight
 * back what was just taken; with it off, Aave's own line, 1.0: as much as Aave lends, and nothing steps in before Aave
 * sells (Adrian, 2026-10-21: "without the protector let the user get liquidated by aave"). Until the Wall opens,
 * ACT_LINE.
 */
export function creditLineFor(p: { wallOpen: boolean; protectOn: boolean }): CreditLine {
  if (!p.wallOpen) return ACT_LINE;
  const round = (hf: number) => Math.round(hf * 100) / 100;
  return p.protectOn
    ? { capHf: round(CASH_AGENT.triggerHf + CAP_MARGIN_HF), stopHf: CASH_AGENT.triggerHf, intoAct: true }
    : { capHf: AAVE_LINE_HF, stopHf: AAVE_LINE_HF, intoAct: true };
}

/** Under the line's stop: no more credit or free up until it's back over it. */
export const pastStop = (healthFactor: number | null, line: CreditLine) =>
  healthFactor !== null && Number.isFinite(healthFactor) && healthFactor < line.stopHf;

/**
 * Protect's numbers (D18). GooseGuard holds the line and target (each account's own, `linesOf`: 1.03 and 1.12 unless it
 * set others, decision 3); GoosePlanner exposes the rest (`thresholds()`, `amounts()`). These mirror the defaults.
 *
 * Protect's line (Adrian, 2026-10-19): Protect acts only below 1.03, as late as is safe before Aave's line at 1.0 (a
 * 2.9% fall; the feeds move in steps of about 0.5%, the largest measured −2.13%). Act (1.1) is a warning only. Once it
 * acts, the rescue goes on until the credit is back at 1.12: savings first, then selling. 1.12 is the same line credit
 * is capped at (CREDIT_CAP.minHf), so Protect puts the account back where it was allowed to be. There is no amount
 * limit (decision 9): like DeFi Saver, Protect is limited by what it does, and a move may not land above the target
 * plus 0.01. GooseGuard never lets a line under 1.03 or a target over 1.40.
 */
export const CASH_AGENT = {
  /** Protect acts below this health factor (Protect's line)… */
  triggerHf: 1.03,
  /** …and brings the credit back to this one, in Watch, savings first, then selling. */
  targetHf: 1.12,
  /** The weekend card (no move, a card only): the price drop it tests just before prices freeze, and the health that
   *  drop must leave, which is Aave's own line. */
  stressDrop: 0.15,
  stressFloorHf: AAVE_LINE_HF,
  /** How long before a freeze the weekend card shows (Friday 14:00–20:00 New York with no holiday; the app reads the
   *  executor's own calendar, so a holiday's eve gets it too). */
  weekendWindowSec: 6 * 3600,
  /** Smallest repay and smallest save worth a round: none (GoosePlanner's `amounts()`, spec-final-v2.md §10). */
  minRepayUsd: 0,
  minSaveUsd: 0,
  /** Most Saves per account per New York day. */
  maxSavesPerDay: 6,
} as const;

/**
 * Protect · sell's numbers (D18): when savings can't bring the credit back to the target, Protect sells backing stock,
 * at once, on Protect's own lines (CASH_AGENT): below 1.03, and on through a rescue until 1.12 (Adrian, 2026-10-19).
 * Weekends too, while the pool sits within 1% of Aave's price (decision 7). Before 2026-10-19: a heads-up below 1.1 and a sale 30 minutes later, at once below 1.05,
 * back to 1.2. Every sale is urgent now, so it takes the urgent floor, 3% under Aave's price. The pool numbers follow
 * the expert panel (eval/protect-panel.json): about 2% of a pool's USDC depth per 10 minutes, and each swap near 1% of
 * it (the Aerodrome pools hold $0.44M–1.57M, 2026-10-14). All wait on calibration (plan item 6 step 9). GooseGuard
 * fixes the floor (SALE_FLOOR_BPS) and the 1% band; the Planner sizes the slices.
 */
export const PROTECT_SELL = {
  floorBps: 300,
  /** All accounts together, into one stock's pool, per 10 minutes. */
  poolCapUsd: 10_000,
  maxSliceUsd: 5_000,
} as const;

/**
 * The Rebalancer's numbers (D18), as locked for plan item 9: a stock breaks its band past the smaller of 20% of its
 * target and 5 points, and goes back to half the band; no trade is too small (GoosePlanner's `rebalanceLimits()`
 * minTrade is 0); each swap is at most $25k. Each swap gets at least Aave's price less 0.5% (GooseGuard's swap floor),
 * and the pool must sit within 1% of Aave's price. All wait on calibration (plan item 6 step 9, item 9 step 5).
 */
export const REBALANCER = {
  /** The band: the smaller of this share of a stock's target… */
  bandOfTarget: 0.2,
  /** …and this many points of the mix. */
  bandMaxPoints: 5,
  poolGapBps: 50,
  floorBps: 50,
  minTradeUsd: 0,
  maxSliceUsd: 25_000,
} as const;

/**
 * The Entry agent's numbers (D18), plan item 2: every swap at 99.5% of face value or better. A swap is at most $10k,
 * under a fifth of the thinnest venue's USDC (Aerodrome's USDbC pool holds $58k and fills $10k at 99.99%, 2026-10-14);
 * a larger balance is split over the next rounds. Both wait on calibration (plan item 6 step 9). GooseGuard fixes the
 * floor, never under 99.5% (SWAP_FLOOR_BPS); the Planner sizes each swap.
 */
export const ENTRY = {
  floorBps: 50,
  minEntryUsd: 1,
  maxSwapUsd: 10_000,
} as const;

/**
 * Savings-first spending (D15): a buy or repay takes what it needs from savings in the same batch.
 * Cautious defaults. M0's real $0-wallet test (plan item 1 step 0) settles both numbers.
 */
export const CASH = {
  /** Wallet USDC that Save never sweeps into savings, so a batch can count on it (the executor's `keepBack`). */
  keepBackUsd: 1,
  /**
   * The fuel tank: left in the wallet after a spend for the network fee, which JAW charges in USDC after the batch, and
   * what "Fill up" brings the wallet back to from savings. $0.50 (Adrian, 2026-10-20: "the tank should be 0.5 not
   * 0.1"), about fifty of the largest fees measured on Base mainnet ($0.0095). It was $0.10 from 2026-10-15, after
   * $0.50 had left an account with $1.36 of cash and $4 owed unable to repay at all; the user can now fill the tank from
   * their cash when it runs low (lib/fuelTank.ts). Every figure and line that names the buffer reads it from here.
   */
  feeBufferUsd: 0.5,
} as const;

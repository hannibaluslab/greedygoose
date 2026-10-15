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
 * Protect's numbers (D18). GooseExecutor holds the live values on-chain, each within hard bounds, and a change waits a
 * public 7-day delay. These mirror its deploy defaults (contracts/script/DeployExecutor.s.sol, checked by
 * contracts/test/DeployExecutor.t.sol); read the live ones with the executor's `thresholds()` and `amounts()`.
 *
 * Act is the line (Adrian, 2026-10-15: "watch is ok, it is act that is not"): Protect steps in only below the Act line
 * and brings the credit back to Watch, not to Safe. 1.2 leaves an 8% cushion (1 − 1.1/1.2) before the credit is back
 * in Act, so a normal day's move doesn't set it off again on the next run, and spends well under half of what
 * reaching Safe would: from 1.05, 12.5% of what's owed against 30%. The executor's bounds keep the trigger at or under
 * the Act line and the target under the Safe line.
 */
export const CASH_AGENT = {
  /** Protect repays from cash below this health factor (the Act line)… */
  triggerHf: RISK.watchMin,
  /** …just enough to bring the credit back to this one, in Watch with room. */
  targetHf: 1.2,
  /**
   * The weekend heads-up (no move, a card only): the price drop it tests just before prices freeze, and the health
   * that drop must leave, which is the Act line.
   */
  stressDrop: 0.15,
  stressFloorHf: RISK.watchMin,
  /** How long before a freeze the weekend heads-up shows (Friday 14:00–20:00 New York with no holiday). */
  weekendWindowSec: 6 * 3600,
  /** Smallest repay and smallest save worth a run. */
  minRepayUsd: 0.05,
  minSaveUsd: 1,
  /** Most Saves per account per New York day. */
  maxSavesPerDay: 6,
} as const;

/**
 * Protect · sell's numbers (D18): when cash can't bring the credit back to Watch, Protect sells backing stock. Act is
 * the line here too (Adrian, 2026-10-15): the heads-up goes out below the Act line, on a weekday, and the sale follows
 * 30 minutes later if the credit is still in Act; deep in Act, below 1.05 (halfway to Aave's limit at 1.0), it sells
 * at once. A sale brings the credit back to Watch at 1.2, the same target as a repay from cash. Before 2026-10-15 the
 * heads-up was below 1.25 and the target 1.4 (plan item 1). The floors and the pool numbers follow the expert panel
 * (eval/protect-panel.json): 1% under Aave's price after a heads-up, 3% at once, about 2% of a pool's USDC depth per
 * 10 minutes, and each swap near 1% of it (the Aerodrome pools hold $0.44M–1.57M, 2026-10-14). All wait on calibration
 * (plan item 6 step 9). GooseExecutor holds the live values within hard bounds (contracts/src/SellRules.sol); a
 * change waits the public 7-day delay.
 */
export const PROTECT_SELL = {
  headsUpHf: RISK.watchMin,
  nowHf: 1.05,
  targetHf: CASH_AGENT.targetHf,
  headsUpDelaySec: 30 * 60,
  floorBps: 100,
  actFloorBps: 300,
  /** All accounts together, into one stock's pool, per 10 minutes. */
  poolCapUsd: 10_000,
  maxSliceUsd: 5_000,
} as const;

/**
 * The Rebalancer's numbers (D18), as locked for plan item 9: a stock breaks its band past the smaller of 20% of its
 * target and 5 points, and goes back to half the band; trades under $20 are skipped; a pool more than 0.5% off Aave's
 * price holds the rebalance; each swap is at most $25k. Each swap gets at least Aave's price less 0.5%, the same as the
 * pool gap. All wait on calibration (plan item 6 step 9, item 9 step 5). GooseExecutor holds the live values within
 * hard bounds (contracts/src/RebalanceRules.sol); a change waits the public 7-day delay, and can only make the floor and
 * the pool gap stricter.
 */
export const REBALANCER = {
  /** The band: the smaller of this share of a stock's target… */
  bandOfTarget: 0.2,
  /** …and this many points of the mix. */
  bandMaxPoints: 5,
  poolGapBps: 50,
  floorBps: 50,
  minTradeUsd: 20,
  maxSliceUsd: 25_000,
} as const;

/**
 * The Entry agent's numbers (D18), plan item 2: every swap at 99.5% of face value or better. A swap is at most $10k,
 * under a fifth of the thinnest venue's USDC (Aerodrome's USDbC pool holds $58k and fills $10k at 99.99%, 2026-10-14);
 * a larger balance is split over the next runs. Both wait on calibration (plan item 6 step 9). GooseExecutor holds
 * the live values within hard bounds, the floor never under 99.5% (contracts/src/EntryRules.sol); a change waits the
 * public 7-day delay.
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
  /** Left in the wallet after a spend for the network fee, which JAW charges in USDC after the batch. */
  feeBufferUsd: 0.5,
} as const;

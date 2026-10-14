/**
 * Display-only status bands over Aave's health factor (decision D2).
 * The app never caps borrowing below Aave's own limit; these only drive the
 * Safe / Watch / Act label and the extra-confirmation rule.
 */
export type RiskBands = { safeMin: number; watchMin: number };

export const RISK: RiskBands = {
  /** Health factor at or above this is Safe. */
  safeMin: 1.5,
  /** Health factor at or above this (and below safeMin) is Watch; below is Act. */
  watchMin: 1.1,
};

/**
 * The Cash Agent's numbers (D18). GooseExecutor holds the live values on-chain, each within hard bounds, and a
 * change waits a public 7-day delay. These mirror its deploy defaults (contracts/script/DeployExecutor.s.sol, checked
 * by contracts/test/DeployExecutor.t.sol); read the live ones with the executor's `thresholds()` and `amounts()`.
 */
export const CASH_AGENT = {
  /** Protect repays from savings below this health factor (the Safe line)… */
  triggerHf: RISK.safeMin,
  /** …back up to this one, so it doesn't fire again on the next run. */
  targetHf: RISK.safeMin + 0.15,
  /** Weekend Shield: the price drop it tests just before prices freeze, and the health that drop must leave. */
  stressDrop: 0.15,
  stressFloorHf: RISK.watchMin,
  /** How long before a freeze Weekend Shield looks (Friday 14:00–20:00 New York with no holiday). */
  weekendWindowSec: 6 * 3600,
  /** Smallest repay and smallest save worth a run. */
  minRepayUsd: 0.05,
  minSaveUsd: 1,
  /** Most Saves per account per New York day. */
  maxSavesPerDay: 6,
} as const;

/**
 * Protect · sell's numbers (D18): when savings can't keep the credit Safe, Protect sells backing stock. Locked with
 * Adrian on 2026-10-13 (plan item 1): a heads-up below 1.25 on a weekday and the sale 30 minutes later, at once below
 * 1.10, back to 1.4. The floors and the pool numbers follow the expert panel (eval/protect-panel.json): 1% under Aave's
 * price normally, 3% in Act, about 2% of a pool's USDC depth per 10 minutes, and each swap near 1% of it (the
 * Aerodrome pools hold $0.44M–1.57M, 2026-10-14). All wait on calibration (plan item 6 step 9). GooseExecutor holds
 * the live values within hard bounds (contracts/src/SellRules.sol); a change waits the public 7-day delay.
 */
export const PROTECT_SELL = {
  headsUpHf: 1.25,
  nowHf: RISK.watchMin,
  targetHf: 1.4,
  headsUpDelaySec: 30 * 60,
  floorBps: 100,
  actFloorBps: 300,
  /** All accounts together, into one stock's pool, per 10 minutes. */
  poolCapUsd: 10_000,
  maxSliceUsd: 5_000,
} as const;

/**
 * The Entry agent's numbers (D18), plan item 2: every swap at 99.5% of face value or better. A swap is at most $10k,
 * under a fifth of the thinnest venue's USDC (Aerodrome's USDbC pool holds $58k and fills $10k at 99.99%, 2026-10-14);
 * a larger balance is split over the next runs. Both wait on calibration (plan item 6 step 9). GooseExecutor holds
 * the live values within hard bounds (contracts/src/EntryRules.sol); a change waits the public 7-day delay.
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

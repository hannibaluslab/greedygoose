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
 * Savings-first spending (D15): a buy or repay takes what it needs from savings in the same batch.
 * Cautious defaults. M0's real $0-wallet test (plan item 1 step 0) settles both numbers.
 */
export const CASH = {
  /** Wallet USDC that Save never sweeps into savings, so a batch can count on it. */
  keepBackUsd: 1,
  /** Left in the wallet after a spend for the network fee, which JAW charges in USDC after the batch. */
  feeBufferUsd: 0.5,
} as const;

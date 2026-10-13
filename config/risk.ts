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

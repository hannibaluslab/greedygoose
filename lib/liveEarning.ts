import { SECONDS_PER_YEAR } from "@/lib/aave/math";

/**
 * The Yield card's live total: what the cash had earned when Base was last read, carried forward at the savings APR on
 * the savings balance. Aave V3's supply interest is linear between the pool's updates, so `savings × apr × t / year`
 * more; each new read restarts it from the chain, so it never drifts. Less cash, slower count; no savings, no count.
 */
export function liveEarnedUsd(earnedUsd: number, savingsUsd: number, apr: number, sinceSec: number): number {
  if (savingsUsd <= 0) return Math.max(0, earnedUsd);
  return Math.max(0, earnedUsd) + (savingsUsd * Math.max(0, apr) * Math.max(0, sinceSec)) / SECONDS_PER_YEAR;
}

/** Digits after the point: enough that the last one moves about once a second, between 2 and 8. */
export function liveDecimals(usd: number, apr: number): number {
  const perSec = (usd * apr) / SECONDS_PER_YEAR;
  if (!(perSec > 0)) return 2;
  return Math.min(8, Math.max(2, Math.ceil(-Math.log10(perSec))));
}

/** "$0.99041237", "$10,952.12345": the counter at its digits. */
export const liveText = (usd: number, decimals: number) =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;

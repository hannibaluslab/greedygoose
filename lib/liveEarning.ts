import { SECONDS_PER_YEAR } from "@/lib/aave/math";

/**
 * The Yield card's live counter: the savings balance as Base last read it, carried forward at the savings APR. Aave
 * V3's supply interest is linear between the pool's updates, so `usd × (1 + apr × t / year)`; each new read restarts
 * it from the balance read, so it never drifts from the chain. Nothing earns, nothing counts: 0 in, 0 out.
 */
export function liveSavingsUsd(usd: number, apr: number, sinceSec: number): number {
  if (usd <= 0) return 0;
  return usd * (1 + (Math.max(0, apr) * Math.max(0, sinceSec)) / SECONDS_PER_YEAR);
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

import type { SettingsHolding } from "@/components/gg/agents/RebalanceSettings";

/*
 * Dev only: Adrian's account as measured on 2026-10-21 (jawegg.justan.id), for the Rebalancer's galleries. $7.74 of
 * stock, Apple 18, Amazon 22, Alphabet 13, Meta 18.5, Microsoft 9, NVIDIA 8, Tesla 11 (%), all of it backing credit
 * but $0.32 of Meta, free in the wallet; his saved mix is Apple 3, Amazon 25, Alphabet 14, Microsoft 58.
 */

const SHARES = [18, 22, 13, 18.5, 9, 8, 11];
const TOTAL_USD = 7.74;
const FREE_META_USD = 0.32;

/** His saved mix, BPS by reserve id. */
export const MEASURED_MIX = [300, 2_500, 1_400, 0, 5_800, 0, 0];

/** His holdings at `prices` (by reserve id), every dollar times `scale`. */
export function measuredAccount(prices: readonly number[], scale: number): SettingsHolding[] {
  return SHARES.map((pct, reserveId) => {
    const price = prices[reserveId];
    const shares = (usd: number) => BigInt(Math.round((usd * scale * 1e8) / price));
    const free = reserveId === 3 ? FREE_META_USD : 0;
    const backing = (pct / 100) * TOTAL_USD - free;
    return {
      reserveId,
      priceRaw: BigInt(Math.round(price * 1e8)),
      freeRaw: shares(free),
      backingRaw: shares(backing),
      backingUsd: backing * scale,
    };
  });
}

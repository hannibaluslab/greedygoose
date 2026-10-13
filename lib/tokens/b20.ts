import { parseUnits } from "viem";

/**
 * B20 multiplier tokens: shares shown to users = raw × uiMultiplier / 1e18.
 * Do maths in raw units; convert only at the edges.
 */
export function sharesToRaw(shares: string, multiplier: bigint, decimals: number): bigint {
  const clean = shares.trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return 0n;
  const [int, frac = ""] = clean.split(".");
  const ui = parseUnits(`${int || "0"}.${frac.slice(0, decimals) || "0"}`, decimals);
  return multiplier > 0n ? (ui * 10n ** 18n) / multiplier : 0n;
}

export const rawToShares = (raw: bigint, multiplier: bigint, decimals: number) =>
  Number((raw * multiplier) / 10n ** 18n) / 10 ** decimals;

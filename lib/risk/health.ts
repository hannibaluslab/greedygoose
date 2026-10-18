import { AAVE_LINE_HF, RISK } from "@/config/risk";

/** One stock's part of the credit's health: its value at Aave's price, the share of it Aave counts, and what it backs. */
type BackingPart = { symbol: string; name: string; valueUsd: number; cf: number; backsUsd: number };

/**
 * How the credit's health is worked out, on Aave's rules: each stock that backs credit counts for its value times its
 * backing factor (Aave sets it per stock), and the health is what they back together ÷ what's owed. Null while the
 * factors aren't read or nothing is owed.
 */
export function healthParts(
  holdings: readonly { symbol: string; name: string; backingUsd: number }[],
  cfs: Record<string, number> | undefined,
  debtUsd: number,
): { parts: BackingPart[]; backsUsd: number; health: number } | null {
  if (!cfs || debtUsd <= 0) return null;
  const parts = holdings.flatMap((h): BackingPart[] => {
    const cf = cfs[h.symbol];
    return h.backingUsd > 0 && cf !== undefined
      ? [{ symbol: h.symbol, name: h.name, valueUsd: h.backingUsd, cf, backsUsd: h.backingUsd * cf }]
      : [];
  });
  const backsUsd = parts.reduce((a, p) => a + p.backsUsd, 0);
  return { parts, backsUsd, health: backsUsd / debtUsd };
}

/**
 * How far the stocks that back credit can fall, all together, before the health reaches `line`: health moves with
 * their prices, so it reaches the line at a fall of 1 − line ÷ health. 0 once it's there. Interest left out.
 */
export const fallTo = (health: number, line: number) => (health > line ? 1 - line / health : 0);

/** The margins the sheet names: the fall to Aave's line, and to Act while the credit is above it. */
export function healthMargins(health: number) {
  return { toAave: fallTo(health, AAVE_LINE_HF), toAct: fallTo(health, RISK.watchMin) };
}

import { rawToShares } from "@/lib/tokens/b20";

/**
 * How one holding splits, for the Home rail's chip, the Invest rows and the stock sheet. Shares that back credit are
 * the ones supplied to Aave; the rest are free.
 */

/** A share of the holding as a whole percent, never "0%" for a part that's there (the chip’s "33% backs credit"). */
export function wholePct(f: number): number {
  return f > 0 ? Math.min(100, Math.max(1, Math.round(f * 100))) : 0;
}

/**
 * What backs credit and what's free, as whole percents that add up to 100 (by shares, so the price doesn't matter).
 * The backing part is rounded as the chip rounds it, so the two always agree.
 */
export function holdingSplit(h: { freeRaw: bigint; backingRaw: bigint }): { backsPct: number; freePct: number } {
  const total = h.freeRaw + h.backingRaw;
  if (total <= 0n) return { backsPct: 0, freePct: 0 };
  const backsPct = wholePct(Number((h.backingRaw * 1_000_000n) / total) / 1_000_000);
  return { backsPct, freePct: 100 - backsPct };
}

/** The holding's share of the stocks held (Invest's "Portfolio"), 0–1; null with no stocks. */
export function portfolioShare(valueUsd: number, stocksUsd: number): number | null {
  return stocksUsd > 0 ? Math.min(1, Math.max(0, valueUsd / stocksUsd)) : null;
}

/**
 * The shares each stock in a batch puts in use, in the batch's order, for the note of what the user signs (Credit
 * Buy's "In one go", Earn with stocks' small print). Throws when a stock's holding isn't read: a line of what is
 * signed is never dropped.
 */
export function backingShares(
  backing: readonly { stock: { symbol: string; decimals: number }; raw: bigint }[],
  holdings: readonly { symbol: string; multiplier: bigint }[],
): { symbol: string; shares: number }[] {
  return backing.map((b) => {
    const h = holdings.find((x) => x.symbol === b.stock.symbol);
    if (!h) throw new Error(`No holding read for ${b.stock.symbol}: the note would leave out what goes in use`);
    return { symbol: b.stock.symbol, shares: rawToShares(b.raw, h.multiplier, b.stock.decimals) };
  });
}

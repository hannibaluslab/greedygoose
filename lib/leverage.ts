/*
 * The leverage tag (canvas boards 12–13, Adrian 2026-10-18): what you hold ÷ your own money, shown next to the credit
 * status on Home while something is owed, and on leaderboard rows. "1.7x" = $1,200 held ÷ $700 yours. No points or
 * levels. Pure, so it's unit-tested (tests/unit/leverage.test.ts).
 */

/** What you hold (Total balance: cash and stocks, the backing included) ÷ what's yours (that, less what's owed). */
export function leverageOf(p: { holdUsd: number; owedUsd: number }): number | null {
  const own = p.holdUsd - p.owedUsd;
  if (!(p.owedUsd > 0) || !(own > 0) || !Number.isFinite(p.holdUsd)) return null;
  return p.holdUsd / own;
}

/** "1.7x": one decimal, rounded down so the tag never says more than it is; "1.0x" never shows (nothing owed). */
export const leverageText = (x: number) => `${(Math.floor(x * 10 + 1e-9) / 10).toFixed(1)}x`;

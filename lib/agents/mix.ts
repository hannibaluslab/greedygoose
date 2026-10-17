import { REBALANCER } from "@/config/risk";
import { stockLimitsRaw, type StockLimits } from "@/lib/agents/permissions";
import { rebalanceTrades, type RebalanceOptions, type RebalanceTrade } from "@/lib/agents/rules/rebalance";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/**
 * The Rebalancer's mix (plan item 9 step 4), set in its agent sheet: the weights GooseExecutor's registry keeps
 * (`setMix`, `mixes`) and what the Rebalancer would trade for them, from its TypeScript rule (lib/agents/rules/rebalance.ts).
 */

/** A whole mix in BPS (RebalanceRules.WHOLE). */
export const MIX_WHOLE = 10_000;

/** One stock on the mix card: its target in BPS. */
export type MixRow = { reserveId: number; bps: number };

/** A stock as the mix sees it: free shares only (shares backing credit stay put) at Aave's price. */
export type MixHolding = { reserveId: number; freeRaw: bigint; priceRaw: bigint };

/** Weights `setMix` takes: one per stock by reserve id, whole BPS, adding up to 100% (or all 0, which clears it). */
export function isMix(weights: readonly number[]): boolean {
  if (weights.length !== EQUITIES.length) return false;
  if (weights.some((w) => !Number.isInteger(w) || w < 0 || w > MIX_WHOLE)) return false;
  const sum = weights.reduce((a, b) => a + b, 0);
  return sum === MIX_WHOLE || sum === 0;
}

/** The registry's mix (`mixes`): 16 bits a stock by reserve id, in BPS. */
export function unpackMix(packed: bigint): number[] {
  return EQUITIES.map((e) => Number((packed >> BigInt(16 * e.reserveId)) & 0xffffn));
}

/** The rows' weights by reserve id, as `setMix` takes them; a stock not on the card is 0. */
export function mixWeights(rows: readonly MixRow[]): number[] {
  return EQUITIES.map((e) => rows.find((r) => r.reserveId === e.reserveId)?.bps ?? 0);
}

/** Whole percents of `values` that add up to 100, by largest remainder (ties go to the earlier one). */
export function wholePercents(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v * 100) / total);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

const valueRaw = (h: MixHolding) => (h.freeRaw * h.priceRaw) / 10n ** 10n;
const holdingOf = (holdings: readonly MixHolding[], reserveId: number) =>
  holdings.find((h) => h.reserveId === reserveId);

/**
 * The rows Rebalance's sheet opens on: the saved mix, largest first; before one is saved, the stocks with free shares at their
 * share now, so nothing trades until the user moves a slider. Dust whose share rounds to 0% is left out (Add a stock
 * brings it back).
 */
export function startingMix(holdings: readonly MixHolding[], saved: readonly number[] | null): MixRow[] {
  if (saved && saved.some((w) => w > 0)) {
    return EQUITIES.filter((e) => saved[e.reserveId] > 0)
      .map((e) => ({ reserveId: e.reserveId, bps: saved[e.reserveId] }))
      .sort((a, b) => b.bps - a.bps);
  }
  const held = holdings
    .filter((h) => h.freeRaw > 0n)
    .sort((a, b) => (valueRaw(b) > valueRaw(a) ? 1 : valueRaw(b) < valueRaw(a) ? -1 : 0));
  const pct = wholePercents(held.map((h) => Number(valueRaw(h))));
  return held.map((h, i) => ({ reserveId: h.reserveId, bps: pct[i] * 100 })).filter((r) => r.bps > 0);
}

/** "now 43%": each row's share of the rows' free stock at Aave's price, rounded on its own; null when there is none. */
export function nowPercents(holdings: readonly MixHolding[], rows: readonly MixRow[]): (number | null)[] {
  const values = rows.map((r) => {
    const h = holdingOf(holdings, r.reserveId);
    return h ? valueRaw(h) : 0n;
  });
  const total = values.reduce((a, b) => a + b, 0n);
  return values.map((v) => (total > 0n ? Math.round(Number((v * 10_000n) / total) / 100) : null));
}

/**
 * The rule's options: GooseExecutor's live `rebalanceLimits()` once read (D18), config/risk.ts REBALANCER (its deploy
 * defaults) before.
 */
export function rebalanceOptions(live?: {
  bandBps: number;
  bandMaxBps: number;
  floorBps: number;
  minTrade: bigint;
  maxSlice: bigint;
}): RebalanceOptions {
  if (live) {
    return {
      bandBps: BigInt(live.bandBps),
      bandMaxBps: BigInt(live.bandMaxBps),
      floorBps: BigInt(live.floorBps),
      minTradeRaw: live.minTrade,
      maxSliceRaw: live.maxSlice,
    };
  }
  const usdc = (usd: number) => BigInt(usd) * 10n ** BigInt(USDC.decimals);
  return {
    bandBps: BigInt(Math.round(REBALANCER.bandOfTarget * MIX_WHOLE)),
    bandMaxBps: BigInt(Math.round(REBALANCER.bandMaxPoints * 100)),
    floorBps: BigInt(REBALANCER.floorBps),
    minTradeRaw: usdc(REBALANCER.minTradeUsd),
    maxSliceRaw: usdc(REBALANCER.maxSliceUsd),
  };
}

/**
 * What the Rebalancer's next run would trade for `rows` on today's free stock: with what its grant's limits still allow
 * this week (`left`), or before it has one with a fresh weekly limit of `capRaw` and the stock limits a grant at that
 * limit carries (`stockLimitsRaw`, each mix stock may be sold). Nothing while the rows don't add up to 100%.
 */
export function previewTrades(p: {
  holdings: readonly MixHolding[];
  rows: readonly MixRow[];
  capRaw: bigint;
  /** The executor's CAP_MAX; the limit itself bounds it before the executor is read. */
  capMaxRaw: bigint | null;
  options: RebalanceOptions;
  /** This week's USDC left and each stock's shares left, by reserve id, from the grant the executor runs. */
  left?: { usdcRaw: bigint; stocksRaw: StockLimits };
}): RebalanceTrade[] {
  const weights = mixWeights(p.rows);
  if (!isMix(weights) || weights.every((w) => w === 0)) return [];
  const prices = EQUITIES.map((e) => holdingOf(p.holdings, e.reserveId)?.priceRaw ?? 0n);
  const limits =
    p.left?.stocksRaw ??
    stockLimitsRaw(
      p.capRaw,
      p.capMaxRaw ?? p.capRaw,
      prices,
      weights.map((w) => w > 0),
    );
  return rebalanceTrades(
    {
      stocks: EQUITIES.map((e) => ({
        sharesRaw: holdingOf(p.holdings, e.reserveId)?.freeRaw ?? 0n,
        price: prices[e.reserveId],
        weightBps: BigInt(weights[e.reserveId]),
        sellLeftRaw: limits[e.reserveId],
      })),
      usdcLeftRaw: p.left?.usdcRaw ?? p.capRaw,
    },
    p.options,
  );
}

/**
 * The Rebalancer (plan item 9): keeps the account's mix of free stock on target, trading only when a stock breaks its
 * band. It sells what grew too big to buy what fell short, so the USDC nets to zero: it never spends cash and never
 * touches savings or backing. Integer on-chain units only, so GooseExecutor's port (contracts/src/RebalanceRules.sol)
 * must agree exactly: test/RebalanceRules.t.sol runs both on the vectors from scripts/agent-vectors.ts.
 *
 * Units: shares and prices with 8 decimals, USDC units with 6, weights and the rest in BPS. A holding is worth
 * shares × price / 1e10 USDC units at Aave's price.
 */

/** One stock, by reserve id. */
export type RebalanceHolding = {
  /** Raw shares in the wallet: free stock, not backing the credit. */
  sharesRaw: bigint;
  /** Aave's oracle price, 8 decimals. */
  price: bigint;
  /** Target weight in BPS; 0 = not in the mix, never traded. The mix adds up to 10,000. */
  weightBps: bigint;
  /** Raw shares the grant's sell limit still allows this period. 0 = can't be sold (not in the grant, or used up). */
  sellLeftRaw: bigint;
};

export type RebalanceBook = {
  /** The seven stocks, by reserve id. */
  stocks: readonly RebalanceHolding[];
  /** USDC units the grant's limit on the buy leg still allows this period. */
  usdcLeftRaw: bigint;
};

export type RebalanceOptions = {
  /** The band is the smaller of this share of the target… */
  bandBps: bigint;
  /** …and this many points of the mix. */
  bandMaxBps: bigint;
  /** Each swap gets at least Aave's price less this. */
  floorBps: bigint;
  /** Smallest trade worth making, USDC units at Aave's price. */
  minTradeRaw: bigint;
  /** Largest swap, USDC units at Aave's price. */
  maxSliceRaw: bigint;
};

/**
 * One swap. A sale swaps `amountIn` raw shares for at least `minOut` USDC units; a buy swaps `amountIn` USDC units for
 * at least `minOut` raw shares. Sales come first: the buys spend exactly what the sales' minimums bring in.
 */
export type RebalanceTrade = { reserveId: number; buy: boolean; amountIn: bigint; minOut: bigint };

const BPS = 10_000n;
const min = (...v: bigint[]) => v.reduce((a, b) => (b < a ? b : a));
const value = (s: RebalanceHolding) => (s.sharesRaw * s.price) / 10n ** 10n;
const sum = (v: readonly bigint[]) => v.reduce((a, b) => a + b, 0n);

/**
 * Match the sides, within the USDC limit: the larger one shrinks, and a trade that falls under the minimum goes, until
 * nothing more drops. Shrinks `sell` and `buy` in place; false when nothing is left to trade.
 */
function matchSides(sell: bigint[], buy: bigint[], usdcLeftRaw: bigint, minTradeRaw: bigint): boolean {
  for (;;) {
    const flow = min(sum(sell), sum(buy), usdcLeftRaw);
    if (flow === 0n) return false;
    let dropped = false;
    for (const legs of [sell, buy]) {
      const t = sum(legs);
      if (t === flow) continue;
      for (let i = 0; i < legs.length; i++) {
        legs[i] = (legs[i] * flow) / t;
        if (legs[i] > 0n && legs[i] < minTradeRaw) {
          legs[i] = 0n;
          dropped = true;
        }
      }
    }
    if (!dropped) return true;
  }
}

/**
 * The trades that bring the mix back. A stock breaks its band when it sits further from its target than the smaller of
 * `bandBps` of the target and `bandMaxBps` points; it is traded back to half the band, and only it. The other side of
 * the trade goes to the stocks still in their band that are furthest from their target (to their target, no further),
 * so the sales and the buys match at Aave's price. Each trade is held to `maxSliceRaw`, a sale to the grant's sell
 * limit for the stock, the buys to the grant's USDC limit; trades under `minTradeRaw` are skipped, and the other side
 * shrinks to match. Nothing to sell or nothing to buy means no trade: the Rebalancer never sells to cash or buys with it.
 */
export function rebalanceTrades(book: RebalanceBook, o: RebalanceOptions): RebalanceTrade[] {
  const s = book.stocks;
  const values = s.map((h) => (h.weightBps > 0n ? value(h) : 0n));
  const total = sum(values);
  if (total === 0n) return [];

  // Signed legs at Aave's price: + sells, − buys. Primary legs bring a broken-out stock back to half its band.
  const sell = s.map(() => 0n);
  const buy = s.map(() => 0n);
  const gap = s.map(() => 0n); // signed distance to target, for the stocks still in their band
  const inBand = s.map(() => false);
  const sellable = s.map((h) => min((h.sellLeftRaw * h.price) / 10n ** 10n, o.maxSliceRaw));
  let primary = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i].weightBps === 0n) continue;
    const target = (total * s[i].weightBps) / BPS;
    const band = (total * min((s[i].weightBps * o.bandBps) / BPS, o.bandMaxBps)) / BPS;
    if (values[i] > target + band) {
      primary = true;
      const leg = min(values[i] - target - band / 2n, sellable[i]);
      if (leg >= o.minTradeRaw) sell[i] = leg;
    } else if (values[i] + band < target) {
      primary = true;
      const leg = min(target - band / 2n - values[i], o.maxSliceRaw);
      if (leg >= o.minTradeRaw) buy[i] = leg;
    } else {
      inBand[i] = true;
      gap[i] = values[i] - target;
    }
  }
  if (!primary) return [];

  // The other side, from the stocks in their band furthest from target first (the fewest swaps).
  let need = sum(sell) - sum(buy);
  const side = need > 0n ? buy : sell;
  const candidates = s
    .map((_, i) => i)
    .filter((i) => inBand[i] && (need > 0n ? gap[i] < 0n : gap[i] > 0n))
    .sort((a, b) => {
      const ga = gap[a] < 0n ? -gap[a] : gap[a];
      const gb = gap[b] < 0n ? -gap[b] : gap[b];
      return ga === gb ? a - b : ga > gb ? -1 : 1;
    });
  if (need < 0n) need = -need;
  for (const i of candidates) {
    if (need === 0n) break;
    const can = gap[i] < 0n ? min(-gap[i], o.maxSliceRaw) : min(gap[i], sellable[i]);
    const leg = min(need, can);
    if (leg < o.minTradeRaw) continue;
    side[i] = leg;
    need -= leg;
  }

  if (!matchSides(sell, buy, book.usdcLeftRaw, o.minTradeRaw)) return [];

  // The sales' minimums pay for the buys, so the wallet's USDC is never lower.
  const trades: RebalanceTrade[] = [];
  let budget = 0n;
  for (let i = 0; i < s.length; i++) {
    if (sell[i] === 0n) continue;
    const shares = (sell[i] * 10n ** 10n) / s[i].price;
    const minOut = (shares * s[i].price * (BPS - o.floorBps)) / 10n ** 14n;
    budget += minOut;
    trades.push({ reserveId: i, buy: false, amountIn: shares, minOut });
  }
  const buys = sum(buy);
  for (let i = 0; i < s.length; i++) {
    if (buy[i] === 0n) continue;
    const usdcIn = (buy[i] * budget) / buys;
    trades.push({
      reserveId: i,
      buy: true,
      amountIn: usdcIn,
      minOut: (usdcIn * 10n ** 10n * (BPS - o.floorBps)) / (s[i].price * BPS),
    });
  }
  return trades;
}

/**
 * Whether a pool's price sits within `gapBps` of Aave's: the Rebalancer skips the day rather than trade a stock whose
 * pool is off. Both prices with 8 decimals.
 */
export function poolInLine(poolPrice: bigint, aavePrice: bigint, gapBps: bigint): boolean {
  const gap = poolPrice > aavePrice ? poolPrice - aavePrice : aavePrice - poolPrice;
  return gap * BPS <= gapBps * aavePrice;
}

/**
 * The Rebalancer's move for one run: the trades, unless a stock it would trade can't be traded now (its pool is off
 * Aave's price, or its reserve is paused), in which case it waits.
 */
export function planRebalance(
  book: RebalanceBook & { tradable: readonly boolean[] },
  o: RebalanceOptions,
): RebalanceTrade[] {
  const trades = rebalanceTrades(book, o);
  return trades.some((t) => !book.tradable[t.reserveId]) ? [] : trades;
}

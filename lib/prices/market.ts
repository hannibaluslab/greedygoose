/**
 * Market prices (plan item 8): today's change, the lines on Home and Invest. They are shown for information only.
 * Values, credit and limits use Aave's oracle (CLAUDE.md, "Oracle"), never these.
 */

/** How far a market price may sit from Aave's for the same stock before it's taken for another token. */
export const PRICE_TOLERANCE = 0.02;

/** As many points as the boards draw: the Home rail card's line, the Invest row's, the hero line over the week. */
export const LINE_POINTS = { card: 11, row: 7, hero: 13 } as const;

/**
 * One stock's market data. `change` is the last 24 hours as a fraction (0.0142 = +1.42%); `day` and `week` are
 * prices over the last 24 hours and the last 7 days, oldest first.
 */
export type MarketData = { price: number; change: number; day: number[]; week: number[] };

export type MarketMap = Record<string, MarketData>;

const isPrice = (n: number) => Number.isFinite(n) && n > 0;

/** True when a market price is within 2% of Aave's price for the stock, so both price the same token. */
export function agreesWithAave(price: number, aaveUsd: number): boolean {
  return isPrice(price) && isPrice(aaveUsd) && Math.abs(price / aaveUsd - 1) <= PRICE_TOLERANCE;
}

/** The data, if its price and the week's last price both agree with Aave's and there are lines to draw. */
export function checked(data: MarketData | undefined, aaveUsd: number): MarketData | undefined {
  if (!data || !Number.isFinite(data.change) || data.change <= -1 || data.day.length < 2 || data.week.length < 2) return undefined;
  return agreesWithAave(data.price, aaveUsd) && agreesWithAave(data.week[data.week.length - 1], aaveUsd) ? data : undefined;
}

/**
 * JAW's answer for each stock where it agrees with Aave, then CoinGecko's where JAW's didn't (`fallback`, checked the
 * same way). `missing` lists the stocks with no usable data yet: the ones to ask CoinGecko for, or to leave blank.
 */
export function pickMarketData(
  stocks: readonly { symbol: string; priceUsd: number }[],
  jaw: MarketMap | undefined,
  fallback?: MarketMap,
): { data: MarketMap; missing: string[] } {
  const data: MarketMap = {};
  const missing: string[] = [];
  for (const { symbol, priceUsd } of stocks) {
    const ok = checked(jaw?.[symbol], priceUsd) ?? checked(fallback?.[symbol], priceUsd);
    if (ok) data[symbol] = ok;
    else missing.push(symbol);
  }
  return { data, missing };
}

/** What a holding worth `valueUsd` now gained over a move of `change`: a day ago it was worth valueUsd / (1 + change). */
export const moveUsd = (valueUsd: number, change: number) => valueUsd - valueUsd / (1 + change);

/**
 * "+$38.20 · +0.76% today" for a total worth `baseUsd` now that holds `stocks`: their moves added up, as a share of
 * what the total was worth a day ago. Null while any stock has no change, since a partial sum would mislead.
 */
export function dayChange(
  stocks: readonly { valueUsd: number; change?: number }[],
  baseUsd: number,
): { usd: number; pct: number } | null {
  if (stocks.length === 0) return null;
  let usd = 0;
  for (const { valueUsd, change } of stocks) {
    if (change == null) return null;
    usd += moveUsd(valueUsd, change);
  }
  const before = baseUsd - usd;
  return before > 0 ? { usd, pct: usd / before } : null;
}

/**
 * What the stocks held now were worth over the week at market prices: each one's value scaled by its price against its
 * last price, added up point by point from the newest, so the line ends on what the stocks are worth now. Series a
 * point or two longer than the shortest lose their oldest points. Null while a stock has fewer than two points.
 */
export function weekValue(stocks: readonly { valueUsd: number; week?: number[] }[]): number[] | null {
  const weeks = stocks.map((s) => s.week ?? []);
  const n = Math.min(...weeks.map((w) => w.length));
  if (stocks.length === 0 || n < 2) return null;
  return Array.from({ length: n }, (_, i) =>
    stocks.reduce((sum, { valueUsd }, k) => sum + (valueUsd * weeks[k][weeks[k].length - n + i]) / weeks[k][weeks[k].length - 1], 0),
  );
}

/** At most `n` evenly spaced points, always ending on the newest (NYM's `downsample`). */
export function downsample(values: number[], n: number): number[] {
  if (n < 2 || values.length <= n) return values;
  const step = (values.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => values[Math.round(i * step)]);
}

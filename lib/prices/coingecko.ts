/**
 * CoinGecko's keyless public API, the fallback for a stock whose JAW price doesn't agree with Aave's. Called from the
 * server route `app/api/prices` only. Each stock's coin id is in the registry (`coingeckoId`).
 *
 *   GET /coins/markets?vs_currency=usd&ids=…&sparkline=true
 *     → [{ id, current_price, price_change_percentage_24h, sparkline_in_7d: { price: number[] } }]
 *
 * One call answers for every stock, with hourly prices over 7 days, oldest first. The public API turns callers away
 * after a few calls a minute (measured 2026-10-14: four calls 3 s apart, then a 429), so one call for all seven stocks
 * beats a chart and a price call per stock.
 */

import type { MarketData } from "./market";

const API = "https://api.coingecko.com/api/v3";

export type CoinRow = {
  id: string;
  current_price?: number | null;
  price_change_percentage_24h?: number | null;
  sparkline_in_7d?: { price?: (number | null)[] } | null;
};

export async function fetchCoinMarkets(ids: readonly string[]): Promise<CoinRow[]> {
  const res = await fetch(`${API}/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(",")}&sparkline=true`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGecko request failed (${res.status})`);
  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) throw new Error("CoinGecko answered without a list");
  return rows as CoinRow[];
}

/**
 * A stock's market data from its CoinGecko row: today's change is the 24-hour change CoinGecko reports, as JAW's is.
 * The hourly line trails the price by up to an hour, so both lines end on the current price, the one the app checks.
 */
export function fromCoinRow(row: CoinRow): MarketData | null {
  const price = row.current_price;
  const change = row.price_change_percentage_24h;
  if (typeof price !== "number" || typeof change !== "number") return null;
  const hourly = (row.sparkline_in_7d?.price ?? []).filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);
  const week = [...hourly, price];
  return { price, change: change / 100, day: week.slice(-25), week };
}

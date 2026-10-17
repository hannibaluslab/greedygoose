/**
 * JAW's market data: the JAW backend proxy, called with the app's JAW API key. NYM's client
 * (`src/lib/prices/marketData.ts`), cut to the two calls GreedyGoose makes:
 *
 *   GET /markets?symbols=NVDAC,AAPLC → [{ symbol, price, change24h, marketCap, spark24h }]
 *   GET /history?symbol=NVDAC&days=7 → prices, oldest first (hourly over 7 days; days 1, 30 and 365 for the chart)
 *
 * It answers by ticker. A stock's ticker is its registry symbol in capitals (NVDAc → NVDAC, the Coinbase tokenized
 * stock's own ticker); a plain ticker can be another token (its META is about $5). Callers check every price against
 * Aave's (`lib/prices/market.ts`) before using it.
 */

import type { MarketData, MarketMap } from "./market";

const MARKET_DATA_BASE = "https://api.justaname.id/proxy/v2/market-data";

const API_KEY = process.env.NEXT_PUBLIC_JAW_API_KEY ?? "";

type MarketRow = { symbol: string; price?: number; change24h?: number; spark24h?: number[] };
type Envelope<T> = { statusCode: number; result: { data: T | null; error: string | null } };

/**
 * Fetch and unwrap JAW's envelope. Throws on a transport error, an envelope error or a null payload (so TanStack
 * Query retries); a gateway 5xx may answer in HTML, so the text is parsed by hand to keep the real status.
 */
async function getData<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${MARKET_DATA_BASE}${path}`, { headers: API_KEY ? { "x-api-key": API_KEY } : {}, signal });
  const text = await res.text();
  let body: Envelope<T>;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(`market-data request failed (${res.status}): non-JSON response`);
  }
  if (!res.ok || body.result?.error)
    throw new Error(body.result?.error ?? `market-data request failed (${res.status})`);
  if (body.result?.data == null) throw new Error("market-data request returned empty data");
  return body.result.data;
}

const prices = (values: unknown[] | undefined) =>
  (values ?? []).filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);

const ticker = (symbol: string) => symbol.toUpperCase();

/** A stock's quote: its price, today's change as a fraction and its 24-hour line. */
type JawQuote = Omit<MarketData, "week">;

/** Quotes for these registry symbols in one /markets call. A stock JAW has no row for is left out. */
export async function fetchJawQuotes(
  symbols: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, JawQuote>> {
  const rows = await getData<MarketRow[]>(
    `/markets?symbols=${encodeURIComponent(symbols.map(ticker).join(","))}`,
    signal,
  );
  const out: Record<string, JawQuote> = {};
  for (const symbol of symbols) {
    const row = rows.find((r) => r?.symbol?.toUpperCase() === ticker(symbol));
    // JAW reports the 24-hour change in percent.
    if (row && typeof row.price === "number" && typeof row.change24h === "number") {
      out[symbol] = { price: row.price, change: row.change24h / 100, day: prices(row.spark24h) };
    }
  }
  return out;
}

/** One stock's prices over the last `days` days, oldest first (/history; `RANGES` in market.ts says how dense). */
export async function fetchJawHistory(symbol: string, days: number, signal?: AbortSignal): Promise<number[]> {
  return prices(await getData<number[]>(`/history?symbol=${encodeURIComponent(ticker(symbol))}&days=${days}`, signal));
}

/** Each stock's hourly prices over the last 7 days, one /history call per stock. A stock whose call fails is left out. */
export async function fetchJawWeeks(
  symbols: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, number[]>> {
  const weeks = await Promise.allSettled(symbols.map((s) => fetchJawHistory(s, 7, signal)));
  return Object.fromEntries(
    symbols.flatMap((s, i) => {
      const week = weeks[i];
      return week.status === "fulfilled" ? [[s, week.value]] : [];
    }),
  );
}

/** Quotes and weeks put together, for the stocks that have both. */
export function jawMarketData(quotes: Record<string, JawQuote>, weeks: Record<string, number[]>): MarketMap {
  return Object.fromEntries(
    Object.entries(quotes).flatMap(([symbol, quote]) =>
      weeks[symbol] ? [[symbol, { ...quote, week: weeks[symbol] }]] : [],
    ),
  );
}

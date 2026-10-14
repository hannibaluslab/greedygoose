"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNowSec } from "./useNowSec";
import type { Holding } from "./usePosition";
import { fetchJawHistory } from "@/lib/prices/jaw";
import { RANGES, afterFirstDay, checkedLine, priceTolerance, type Range } from "@/lib/prices/market";

/** The CoinGecko fallback, through the app's own stateless route. */
async function fetchFallback(symbol: string, range: Range, signal: AbortSignal): Promise<number[]> {
  const res = await fetch(`/api/prices/history?s=${encodeURIComponent(symbol)}&r=${range}`, { signal });
  if (!res.ok) throw new Error(`price history route failed (${res.status})`);
  return afterFirstDay(range, await res.json());
}

/** The densest range (1D) moves every 5 minutes; the others hourly or daily. */
const FRESH_MS = 300_000;

/**
 * One stock's market prices over a chart range, as useMarketPrices reads today's: JAW's history first, and CoinGecko's
 * through /api/prices/history when JAW's doesn't end within 2% of Aave's price (10% while markets are closed; the META
 * trap is far outside either) or doesn't answer. A young token's year starts the day after its first (afterFirstDay).
 * While a new range loads, the last range's line stays up with `stale` set, as NYM's chart fades it. Information
 * only: values and credit use Aave's prices.
 */
export function usePriceHistory(stock: Pick<Holding, "symbol" | "priceUsd">, range: Range) {
  const { symbol, priceUsd } = stock;
  const tolerance = priceTolerance(useNowSec() * 1000);
  const jaw = useQuery({
    queryKey: ["priceHistory", symbol, range],
    staleTime: FRESH_MS,
    refetchInterval: FRESH_MS,
    // One retry, then CoinGecko: a JAW outage shouldn't hold the chart for TanStack's three.
    retry: 1,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => afterFirstDay(range, await fetchJawHistory(symbol, RANGES[range], signal)),
  });
  const fromJaw = jaw.isPlaceholderData ? undefined : checkedLine(jaw.data, priceUsd, tolerance);
  const needFallback = !jaw.isPending && !jaw.isPlaceholderData && !fromJaw;

  const fallback = useQuery({
    queryKey: ["priceHistoryFallback", symbol, range],
    enabled: needFallback,
    staleTime: FRESH_MS,
    refetchInterval: FRESH_MS,
    retry: 1,
    queryFn: ({ signal }) => fetchFallback(symbol, range, signal),
  });

  const points = fromJaw ?? (needFallback ? checkedLine(fallback.data, priceUsd, tolerance) : undefined);
  const previous = jaw.isPlaceholderData ? checkedLine(jaw.data, priceUsd, tolerance) : undefined;
  const settled = !jaw.isPending && !jaw.isPlaceholderData && (!needFallback || !fallback.isPending);
  return {
    /** The range's line, or the last range's while this one loads (`stale`); null once neither source has one. */
    points: points ?? previous ?? null,
    stale: !points && !!previous,
    loading: !points && !settled,
    retry: () => {
      void jaw.refetch();
      if (needFallback) void fallback.refetch();
    },
  };
}

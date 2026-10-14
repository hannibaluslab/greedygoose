"use client";

import { useQuery } from "@tanstack/react-query";
import { useNowSec } from "./useNowSec";
import type { Holding } from "./usePosition";
import { fetchJawQuotes, fetchJawWeeks, jawMarketData } from "@/lib/prices/jaw";
import { pickMarketData, priceTolerance, type MarketMap } from "@/lib/prices/market";

/** The CoinGecko fallback, through the app's own stateless route. */
async function fetchFallback(symbols: readonly string[], signal: AbortSignal): Promise<MarketMap> {
  const res = await fetch(`/api/prices?s=${encodeURIComponent(symbols.join(","))}`, { signal });
  if (!res.ok) throw new Error(`price route failed (${res.status})`);
  return res.json();
}

/**
 * Market data for the stocks held, each with Aave's price (plan item 8): today's change and the lines. JAW's comes
 * first; a stock whose JAW price isn't within 2% of Aave's (10% while markets are closed), or that JAW didn't answer
 * for, comes from CoinGecko through /api/prices, checked the same way. `complete` once every stock held has data; `loading` until each stock has data or
 * has failed both. Information only: values and credit use Aave's prices.
 */
export function useMarketPrices(held: readonly Pick<Holding, "symbol" | "priceUsd">[]) {
  const symbols = held.map((h) => h.symbol);
  const enabled = symbols.length > 0;
  const tolerance = priceTolerance(useNowSec() * 1000);

  const quotes = useQuery({
    queryKey: ["marketQuotes", symbols],
    enabled,
    refetchInterval: 60_000,
    // One retry, then CoinGecko: a JAW outage shouldn't hold the screen for TanStack's three.
    retry: 1,
    queryFn: ({ signal }) => fetchJawQuotes(symbols, signal),
  });
  // Hourly points: a week read every 10 minutes is current enough.
  const weeks = useQuery({
    queryKey: ["marketWeeks", symbols],
    enabled,
    staleTime: 600_000,
    refetchInterval: 600_000,
    retry: 1,
    queryFn: ({ signal }) => fetchJawWeeks(symbols, signal),
  });

  const jawSettled = !quotes.isPending && !weeks.isPending;
  const jaw = quotes.data && weeks.data ? jawMarketData(quotes.data, weeks.data) : undefined;
  const { missing } = pickMarketData(held, tolerance, jaw);

  const fallback = useQuery({
    queryKey: ["marketFallback", missing],
    enabled: jawSettled && missing.length > 0,
    refetchInterval: 120_000,
    retry: 1,
    queryFn: ({ signal }) => fetchFallback(missing, signal),
  });

  const picked = pickMarketData(held, tolerance, jaw, fallback.data);
  const fallbackSettled = missing.length === 0 || !fallback.isPending;
  return {
    bySymbol: picked.data,
    complete: enabled && picked.missing.length === 0,
    loading: enabled && picked.missing.length > 0 && !(jawSettled && fallbackSettled),
    retry: () => {
      void quotes.refetch();
      void weeks.refetch();
      if (missing.length > 0) void fallback.refetch();
    },
  };
}

export type MarketPrices = ReturnType<typeof useMarketPrices>;

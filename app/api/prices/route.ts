import { cacheLife } from "next/cache";
import { fetchCoinMarkets, fromCoinRow } from "@/lib/prices/coingecko";
import type { MarketMap } from "@/lib/prices/market";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * The market-price fallback (plan item 8): GET /api/prices?s=METAc,NVDAc → { METAc: MarketData, … } from CoinGecko,
 * for the stocks whose JAW price didn't agree with Aave's. Stocks resolve through the registry only; any other symbol
 * is ignored. No key and no storage: it fetches all seven stocks in one CoinGecko call, caches the answer for two
 * minutes (CoinGecko's public API allows only a few calls a minute) and returns the ones asked for. The app checks
 * every price against Aave's again before showing it.
 */
export async function GET(request: Request) {
  const asked = new Set(new URL(request.url).searchParams.get("s")?.split(",") ?? []);
  const stocks = EQUITIES.filter((e) => asked.has(e.symbol));
  if (stocks.length === 0) return Response.json({ error: "Ask for a supported stock, as ?s=NVDAc" }, { status: 400 });

  const rows = await coinMarkets().catch(() => null);
  if (!rows) return Response.json({ error: "CoinGecko didn't answer" }, { status: 502 });

  const out: MarketMap = {};
  for (const s of stocks) {
    const row = rows.find((r) => r.id === s.coingeckoId);
    const data = row && fromCoinRow(row);
    if (data) out[s.symbol] = data;
  }
  return Response.json(out, { headers: { "cache-control": "public, max-age=60" } });
}

/** Every stock's row, one cache entry for all, whichever stocks a request asks for. */
async function coinMarkets() {
  "use cache";
  cacheLife({ stale: 60, revalidate: 120, expire: 3600 });
  return fetchCoinMarkets(EQUITIES.map((e) => e.coingeckoId));
}

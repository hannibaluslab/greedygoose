import { cacheLife } from "next/cache";
import { fetchCoinChart } from "@/lib/prices/coingecko";
import { RANGES, isRange } from "@/lib/prices/market";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * The chart's fallback: GET /api/prices/history?s=NVDAc&r=1M → prices, oldest first, from CoinGecko, for a stock
 * whose JAW history didn't agree with Aave's price. The stock resolves through the registry and the range through
 * RANGES only, so nothing a caller sends reaches CoinGecko. No key and no storage; each stock and range is cached for
 * two minutes (CoinGecko's public API allows only a few calls a minute). The app checks the line against Aave's price
 * again before drawing it.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const stock = EQUITIES.find((e) => e.symbol === params.get("s"));
  const range = params.get("r");
  if (!stock || !isRange(range)) return Response.json({ error: "Ask for a supported stock and range, as ?s=NVDAc&r=1M" }, { status: 400 });

  const points = await chart(stock.coingeckoId, RANGES[range]).catch(() => null);
  if (!points || points.length < 2) return Response.json({ error: "CoinGecko didn't answer" }, { status: 502 });
  return Response.json(points, { headers: { "cache-control": "public, max-age=60" } });
}

async function chart(id: string, days: number) {
  "use cache";
  cacheLife({ stale: 60, revalidate: 120, expire: 3600 });
  return fetchCoinChart(id, days);
}

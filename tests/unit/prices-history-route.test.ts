import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJawHistory } from "@/lib/prices/jaw";
import { EQUITIES } from "@/lib/tokens/registry";

// The route caches through Next's "use cache"; outside Next there is no cache to configure.
vi.mock("next/cache", () => ({ cacheLife: () => {} }));
const { GET } = await import("@/app/api/prices/history/route");

const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
/** /market_chart's shape: [ms, price] pairs, oldest first. */
const chart = (prices: number[]) => ({
  prices: prices.map((p, i) => [1_791_882_900_000 + i * 300_000, p]),
  market_caps: [],
  total_volumes: [],
});
const ask = (query: string) => GET(new Request(`http://localhost/api/prices/history${query}`));

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/prices/history (the chart's CoinGecko fallback)", () => {
  it("asks CoinGecko for the stock's coin over the range's days and answers with the prices", async () => {
    const fetch = vi.fn(async () => Response.json(chart([212.86, 220.4, 229.13])));
    vi.stubGlobal("fetch", fetch);
    const res = await ask("?s=NVDAc&r=1M");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([212.86, 220.4, 229.13]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      `https://api.coingecko.com/api/v3/coins/${nvda.coingeckoId}/market_chart?vs_currency=usd&days=30`,
    );
  });

  it("maps each range to its days", async () => {
    for (const [r, days] of [
      ["1D", 1],
      ["1W", 7],
      ["1Y", 365],
    ] as const) {
      const fetch = vi.fn(async () => Response.json(chart([1, 2])));
      vi.stubGlobal("fetch", fetch);
      await ask(`?s=NVDAc&r=${r}`);
      expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(new RegExp(`&days=${days}$`));
    }
  });

  it("resolves the stock through the registry and the range through RANGES only, without calling CoinGecko", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const q of [
      "?s=bitcoin&r=1M",
      "?s=NVDA&r=1M",
      "?s=NVDAc&r=5Y",
      "?s=NVDAc&r=constructor",
      "?s=NVDAc",
      "?r=1D",
      "",
    ]) {
      expect((await ask(q)).status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops gaps and bad points", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ prices: [[1, 220], [2, null], [3, 0], "x", [4, 229.13]] })),
    );
    expect(await (await ask("?s=NVDAc&r=1D")).json()).toEqual([220, 229.13]);
  });

  it("answers 502 when CoinGecko turns it away or has no line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: { error_code: 429 } }, { status: 429 })),
    );
    expect((await ask("?s=NVDAc&r=1D")).status).toBe(502);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(chart([229.13]))),
    );
    expect((await ask("?s=NVDAc&r=1D")).status).toBe(502);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "coin not found" })),
    );
    expect((await ask("?s=NVDAc&r=1D")).status).toBe(502);
  });
});

describe("fetchJawHistory", () => {
  const envelope = (data: unknown, error: string | null = null) => ({ statusCode: 200, result: { data, error } });

  it("asks JAW's /history for the stock's own ticker and the days, and keeps the good points", async () => {
    const fetch = vi.fn(async () => Response.json(envelope([212.86, null, 0, 229.13])));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchJawHistory("NVDAc", 30)).toEqual([212.86, 229.13]);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      "https://api.justaname.id/proxy/v2/market-data/history?symbol=NVDAC&days=30",
    );
  });

  it("throws on an envelope error, so the hook can retry and then fall back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(envelope(null, "unknown symbol"))),
    );
    await expect(fetchJawHistory("NVDAc", 1)).rejects.toThrow("unknown symbol");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { EQUITIES } from "@/lib/tokens/registry";

// The route caches through Next's "use cache"; outside Next there is no cache to configure.
vi.mock("next/cache", () => ({ cacheLife: () => {} }));
const { GET } = await import("@/app/api/prices/route");

const hourly = (price: number) => Array.from({ length: 168 }, (_, i) => price * (0.96 + (0.04 * i) / 167));
const ROWS = EQUITIES.map((e, i) => ({
  id: e.coingeckoId,
  current_price: 100 + i,
  price_change_percentage_24h: 1.5,
  sparkline_in_7d: { price: hourly(100 + i) },
}));

const ask = (query: string) => GET(new Request(`http://localhost/api/prices${query}`));

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/prices (the CoinGecko fallback)", () => {
  it("asks CoinGecko once for every stock and answers for the ones asked", async () => {
    const fetch = vi.fn(async () => Response.json(ROWS));
    vi.stubGlobal("fetch", fetch);
    const res = await ask("?s=METAc,NVDAc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["METAc", "NVDAc"]);
    expect(body.METAc).toMatchObject({ price: 103, change: 0.015 });
    expect(body.METAc.week).toHaveLength(169);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = String((fetch.mock.calls[0] as unknown[])[0]);
    expect(url).toMatch(/^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/markets\?/);
    for (const e of EQUITIES) expect(url).toContain(e.coingeckoId);
  });

  it("resolves stocks through the registry only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(ROWS)),
    );
    const body = await (await ask("?s=NVDAc,NVDA,bitcoin,0xb20000000000000000000078ee7ce2fE4908108C")).json();
    expect(Object.keys(body)).toEqual(["NVDAc"]);
  });

  it("refuses a request for no supported stock without calling CoinGecko", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await ask("?s=bitcoin")).status).toBe(400);
    expect((await ask("")).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 502 when CoinGecko turns it away", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: { error_code: 429 } }, { status: 429 })),
    );
    expect((await ask("?s=METAc")).status).toBe(502);
  });

  it("leaves out a stock CoinGecko has no price for", async () => {
    const rows = ROWS.map((r) => (r.id === "meta-coinbase-tokenized-stock" ? { ...r, current_price: null } : r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(rows)),
    );
    const body = await (await ask("?s=METAc,NVDAc")).json();
    expect(Object.keys(body)).toEqual(["NVDAc"]);
  });
});

import { describe, expect, it } from "vitest";
import { rebalanceOptions } from "@/lib/agents/mix";
import { investTrades, sendToFixRaw } from "@/lib/agents/rules/topUps";

const o = rebalanceOptions();
const PRICE = 100n * 10n ** 8n; // $100 a share
const shares = (usd: number) => (BigInt(Math.round(usd * 1e6)) * 10n ** 10n) / PRICE;
const stock = (freeUsd: number, backingUsd: number, weightBps: number) => ({
  sharesRaw: shares(freeUsd),
  backingRaw: shares(backingUsd),
  price: PRICE,
  weightBps: BigInt(weightBps),
});

/** The stocks once `amountRaw` went in as today's top-ups put it in (all at once). */
function after(stocks: ReturnType<typeof stock>[], amountRaw: bigint) {
  const buys = investTrades({ stocks: stocks.map((s) => ({ ...s, sellLeftRaw: 0n })) }, amountRaw, {
    floorBps: 0n,
    minTradeRaw: 0n,
    maxSliceRaw: amountRaw,
  });
  return stocks.map((s, i) => {
    const t = buys.find((b) => b.reserveId === i);
    return t ? { ...s, sharesRaw: s.sharesRaw + (t.amountIn * 10n ** 10n) / PRICE } : s;
  });
}

describe("sendToFixRaw: what to send so today's top-ups fix the whole mix", () => {
  it("nothing past its band: nothing to send", () => {
    expect(sendToFixRaw([stock(50, 0, 5000), stock(0, 50, 5000)], o)).toBe(0n);
  });

  it("stock backing credit too big for its share: the smallest amount that fixes it, to the cent", () => {
    // Apple backs credit at $1.42 against 3%; the rest of the mix is free and small.
    const stocks = [stock(0, 1.42, 300), stock(0.2, 0, 2500), stock(0.2, 0, 1400), stock(0.2, 0, 5800)];
    const x = sendToFixRaw(stocks, o)!;
    expect(x).toBeGreaterThan(0n);
    expect(x % 10_000n).toBe(0n);
    expect(sendToFixRaw(after(stocks, x), o)).toBe(0n);
    expect(sendToFixRaw(after(stocks, x - 10_000n), o)).toBeGreaterThan(0n);
  });

  it("a mix nothing can fix within the cap: null", () => {
    // All of the mix's only stock backs credit at a 1% share while the other 99% can't be bought (no price).
    const stocks = [stock(0, 1_000, 100), { ...stock(0, 0, 9900), price: 0n }];
    expect(sendToFixRaw(stocks, o, 10n ** 6n)).toBeNull();
  });
});

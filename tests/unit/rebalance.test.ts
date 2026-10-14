import { describe, expect, it } from "vitest";
import { planRebalance, poolInLine, rebalanceTrades, type RebalanceBook, type RebalanceHolding } from "@/lib/guardian/rebalance";

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const price = (n: number) => BigInt(n) * 10n ** 8n;
const ALL = 10n ** 18n;
const none: RebalanceHolding = { sharesRaw: 0n, price: price(1), weightBps: 0n, sellLeftRaw: 0n };
/** `value` dollars of free stock at `p`, `weight` % of the mix. */
const holding = (value: number, p: number, weightPct: number, sellLeftRaw = ALL): RebalanceHolding => ({
  sharesRaw: (usd(value) * 10n ** 10n) / price(p),
  price: price(p),
  weightBps: BigInt(Math.round(weightPct * 100)),
  sellLeftRaw,
});
/** NVIDIA at reserve 5, Apple at 0, Tesla at 6. */
const book = (stocks: Partial<Record<number, RebalanceHolding>>, usdcLeftRaw = 10n ** 15n): RebalanceBook => ({
  stocks: Array.from({ length: 7 }, (_, r) => stocks[r] ?? none),
  usdcLeftRaw,
});
/** config/risk.ts REBALANCER. */
const opts = { bandBps: 2_000n, bandMaxBps: 500n, floorBps: 50n, minTradeRaw: usd(20), maxSliceRaw: usd(25_000) };
const valueOf = (shares: bigint, p: number) => Number((shares * price(p)) / 10n ** 10n) / 1e6;

describe("rebalanceTrades (the Rebalancer, plan item 9)", () => {
  it("brings a 50/50 mix drifted to 56/44 back to about 52.5/47.5, the buy paid by the sale", () => {
    const t = rebalanceTrades(book({ 5: holding(5_600, 200, 50), 0: holding(4_400, 250, 50) }), opts);
    expect(t.map((x) => [x.reserveId, x.buy])).toEqual([
      [5, false],
      [0, true],
    ]);
    expect(valueOf(t[0].amountIn, 200)).toBe(350);
    expect(t[1].amountIn).toBe(t[0].minOut);
  });

  it("holds a 55/45 mix inside its 5-point band and trades 61/39 back to half of it", () => {
    expect(rebalanceTrades(book({ 5: holding(5_900, 200, 55), 0: holding(4_100, 250, 45) }), opts)).toEqual([]);
    const t = rebalanceTrades(book({ 5: holding(6_100, 200, 55), 0: holding(3_900, 250, 45) }), opts);
    expect(valueOf(t[0].amountIn, 200)).toBe(350);
  });

  it("gives a small target a band of a fifth of it: 17.1% ± 3.42, 11.4% ± 2.28", () => {
    const at = (nvda: number, aapl: number, tsla: number) =>
      rebalanceTrades(book({ 5: holding(nvda, 200, 17.1), 0: holding(aapl, 250, 11.4), 6: holding(tsla, 250, 71.5) }), opts);
    expect(at(2_052, 1_140, 6_808)).toEqual([]);
    expect(valueOf(at(2_100, 1_140, 6_760)[0].amountIn, 200)).toBeCloseTo(219, 0); // back to 18.81%
    const t = at(1_710, 900, 7_390);
    expect(t.at(-1)).toMatchObject({ reserveId: 0, buy: true }); // Apple under 9.12%, back to 10.26%
  });

  it("trades only the stock that broke out, the other side from the one furthest off its target", () => {
    // The Manage board's 50/25/25 at 43/27/30: NVIDIA broke out; Tesla, 5 points over, pays; Apple stays put.
    const t = rebalanceTrades(book({ 5: holding(4_300, 200, 50), 0: holding(2_700, 250, 25), 6: holding(3_000, 300, 25) }), opts);
    expect(t.map((x) => [x.reserveId, x.buy])).toEqual([
      [6, false],
      [5, true],
    ]);
    expect(valueOf(t[0].amountIn, 300)).toBe(450);
  });

  it("skips trades under $20, a used-up weekly limit, and never sells to cash or buys with it", () => {
    expect(rebalanceTrades(book({ 5: holding(336, 200, 50), 0: holding(264, 250, 50) }), opts)).toHaveLength(2);
    expect(rebalanceTrades(book({ 5: holding(280, 200, 50), 0: holding(220, 250, 50) }), opts)).toEqual([]);
    expect(rebalanceTrades(book({ 5: holding(5_600, 200, 50, 0n), 0: holding(4_400, 250, 50) }), opts)).toEqual([]);
    expect(rebalanceTrades(book({ 5: holding(5_600, 200, 50), 0: holding(4_400, 250, 50) }, 0n), opts)).toEqual([]);
  });

  it("makes at most a $25k swap a day, and ignores free stock outside the mix", () => {
    const t = rebalanceTrades(book({ 5: holding(1_400_000, 200, 50), 0: holding(600_000, 250, 50), 6: holding(50_000, 300, 0) }), opts);
    expect(t).toHaveLength(2);
    expect(valueOf(t[0].amountIn, 200)).toBe(25_000);
  });
});

describe("planRebalance", () => {
  it("waits when a stock it would trade can't be traded now", () => {
    const b = book({ 5: holding(5_600, 200, 50), 0: holding(4_400, 250, 50) });
    expect(planRebalance({ ...b, tradable: b.stocks.map(() => true) }, opts)).toHaveLength(2);
    expect(planRebalance({ ...b, tradable: b.stocks.map((_, r) => r !== 0) }, opts)).toEqual([]);
    expect(planRebalance({ ...b, tradable: b.stocks.map((_, r) => r !== 3) }, opts)).toHaveLength(2); // Meta: not traded
  });

  it("calls a pool in line within 0.5% of Aave's price either way", () => {
    expect(poolInLine(price(100) + price(1) / 2n, price(100), 50n)).toBe(true);
    expect(poolInLine(price(100) - price(1) / 2n, price(100), 50n)).toBe(true);
    expect(poolInLine(price(100) + price(1) / 2n + 1n, price(100), 50n)).toBe(false);
  });
});

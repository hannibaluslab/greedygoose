import { describe, expect, it } from "vitest";
import { previewTrades, rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import type { StockLimits } from "@/lib/agents/permissions";
import { rebalanceAllows, rebalanceSave, rebalanceSteps, tradeLines } from "@/lib/agents/rebalanceSettings";
import type { RebalanceTrade } from "@/lib/agents/rules/rebalance";

const usdc = (usd: number) => BigInt(usd) * 10n ** 6n;
const price = (usd: number) => BigInt(Math.round(usd * 1e8));
// NVIDIA, Apple, Tesla at 43/26/30 of $9,900 in free shares (the Manage board's figures).
const HOLDINGS: MixHolding[] = [
  { reserveId: 5, priceRaw: price(178.57), freeRaw: BigInt(Math.round((4_300 / 178.57) * 1e8)) },
  { reserveId: 0, priceRaw: price(222.22), freeRaw: BigInt(Math.round((2_600 / 222.22) * 1e8)) },
  { reserveId: 6, priceRaw: price(378.38), freeRaw: BigInt(Math.round((3_000 / 378.38) * 1e8)) },
];

describe("tradeLines", () => {
  it("prices sales at Aave's price and buys at what they spend, sells first and largest first", () => {
    const trades: RebalanceTrade[] = [
      { reserveId: 5, buy: true, amountIn: usdc(300), minOut: 0n },
      { reserveId: 0, buy: false, amountIn: (usdc(50) * 10n ** 10n) / price(222.22), minOut: 0n },
      { reserveId: 6, buy: false, amountIn: (usdc(250) * 10n ** 10n) / price(378.38), minOut: 0n },
    ];
    expect(tradeLines(trades, HOLDINGS)).toEqual([
      { reserveId: 6, name: "Tesla", buy: false, usd: 250 },
      { reserveId: 0, name: "Apple", buy: false, usd: 50 },
      { reserveId: 5, name: "NVIDIA", buy: true, usd: 300 },
    ]);
  });

  it("leaves out a trade under half a dollar", () => {
    expect(tradeLines([{ reserveId: 5, buy: true, amountIn: 400_000n, minOut: 0n }], HOLDINGS)).toEqual([]);
  });

  it("reads the Rebalancer's own rule on the board's mix", () => {
    const rows = [
      { reserveId: 5, bps: 5_000 },
      { reserveId: 0, bps: 2_500 },
      { reserveId: 6, bps: 2_500 },
    ];
    // No amount limit: the preview runs at the executor's CAP_MAX, so the band alone shapes the trades.
    const trades = previewTrades({
      holdings: HOLDINGS,
      rows,
      capRaw: usdc(10_000),
      capMaxRaw: usdc(10_000),
      options: rebalanceOptions(),
    });
    const lines = tradeLines(trades, HOLDINGS);
    expect(lines.length).toBeGreaterThan(0);
    // NVIDIA is under its target, so it's the one bought, with no more than the sales bring in.
    expect(lines.filter((l) => l.buy).map((l) => l.name)).toEqual(["NVIDIA"]);
    const sold = lines.filter((l) => !l.buy).reduce((a, l) => a + l.usd, 0);
    expect(lines.filter((l) => l.buy).reduce((a, l) => a + l.usd, 0)).toBeLessThanOrEqual(sold);
  });
});

describe("rebalanceSave", () => {
  const mix = [2_500, 0, 0, 0, 0, 5_000, 2_500];
  const limits: StockLimits = [1n, 0n, 0n, 0n, 0n, 1n, 1n];
  const base = {
    configured: true,
    connected: true,
    saved: mix,
    weights: mix,
    terms: { capRaw: usdc(10_000), limitsRaw: limits },
    capMaxRaw: usdc(10_000),
    running: true,
    feeBlocked: false,
    feeLoading: false,
    busy: false,
  };

  it("says Not live yet and saves nothing without an executor", () => {
    expect(rebalanceSave({ ...base, configured: false, saved: null, terms: null })).toEqual({
      mixChanged: false,
      needsGrant: false,
      steps: 0,
      canSave: false,
      note: "Not live yet",
    });
  });

  it("has nothing to save when the mix is what it runs with, on a grant at CAP_MAX", () => {
    expect(rebalanceSave(base)).toMatchObject({ steps: 0, canSave: false, note: null });
  });

  it("takes one step for a new mix in stocks it may already sell", () => {
    const weights = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...base, weights })).toMatchObject({
      mixChanged: true,
      needsGrant: false,
      steps: 1,
      canSave: true,
      note: null,
    });
  });

  it("needs a new grant at CAP_MAX for a capped grant from before: one batch, approved and registered", () => {
    const capped = { ...base, terms: { capRaw: usdc(100), limitsRaw: limits } };
    expect(rebalanceSave(capped)).toMatchObject({
      mixChanged: false,
      needsGrant: true,
      steps: 1,
      canSave: true,
      note: null,
    });
    // Until CAP_MAX is read nothing saves, and the grant isn't judged capped yet.
    expect(rebalanceSave({ ...capped, capMaxRaw: null })).toMatchObject({ needsGrant: false, canSave: false });
  });

  it("takes one batch for a stock the grant can't sell yet: the new grant and the mix together", () => {
    const weights = [2_500, 2_500, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...base, weights })).toMatchObject({
      mixChanged: true,
      needsGrant: true,
      steps: 1,
      note: null,
    });
  });

  it("switches it on with the first mix", () => {
    expect(rebalanceSave({ ...base, saved: [0, 0, 0, 0, 0, 0, 0], terms: null, running: false })).toMatchObject({
      steps: 1,
      canSave: true,
      note: null,
    });
    expect(rebalanceSave({ ...base, terms: null, running: false })).toMatchObject({
      steps: 1,
      canSave: true,
      note: null,
    });
  });

  it("stays disabled until the mix adds up to 100%", () => {
    const weights = [2_500, 0, 0, 0, 0, 4_000, 2_500];
    expect(rebalanceSave({ ...base, weights })).toMatchObject({
      canSave: false,
      note: "Make your mix add up to 100% to save it.",
    });
  });

  it("stays disabled while fees can't be paid, it's busy, or signed out", () => {
    const weights = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...base, weights, feeBlocked: true })).toMatchObject({
      canSave: false,
      note: "Your account can’t pay network fees from your cash right now.",
    });
    expect(rebalanceSave({ ...base, weights, busy: true }).canSave).toBe(false);
    expect(rebalanceSave({ ...base, weights, feeLoading: true }).canSave).toBe(false);
    expect(rebalanceSave({ ...base, weights, connected: false }).canSave).toBe(false);
    expect(rebalanceSave({ ...base, weights, capMaxRaw: null }).canSave).toBe(false);
  });
});

describe('rebalanceSteps: Save is one batch, one Face ID (Adrian, 2026-10-20: "in one signature")', () => {
  it("one batch when the grant or the mix changed, nothing otherwise", () => {
    expect(rebalanceSteps({ needsGrant: true, mixChanged: true })).toEqual(["batch"]);
    expect(rebalanceSteps({ needsGrant: true, mixChanged: false })).toEqual(["batch"]);
    expect(rebalanceSteps({ needsGrant: false, mixChanged: true })).toEqual(["batch"]);
    expect(rebalanceSteps({ needsGrant: false, mixChanged: false })).toEqual([]);
  });

  it("says what the Face ID lets Rebalance do, and that it never spends cash until top-ups are on", () => {
    expect(rebalanceAllows()).toBe(
      "Rebalance can trade your stocks toward your mix, for a year. It never spends your cash. You can turn it off here.",
    );
    expect(rebalanceAllows({ keepUsd: "$500" })).toMatch(/top-ups above \$500/);
    expect(rebalanceAllows({ keepUsd: "$500" })).not.toMatch(/never spends/);
  });
});

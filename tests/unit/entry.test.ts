import { describe, expect, it } from "vitest";
import { planEntry, type EntryCoin } from "@/lib/guardian/entry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/** USDT, USDe, USDbC, USDS (lib/tokens/stables.ts), empty, with limits that never bind. */
const coins = (over: Partial<Record<number, Partial<EntryCoin>>> = {}): EntryCoin[] =>
  ENTRY_COINS.map((c, i) => ({
    balanceRaw: 0n,
    decimals: c.decimals,
    limitLeftRaw: 10n ** 30n,
    waiting: false,
    ...over[i],
  }));
/** config/risk.ts ENTRY. */
const opts = { floorBps: 50n, minEntryRaw: 1_000_000n, maxSwapRaw: 10_000_000_000n };

describe("planEntry (the Entry agent, plan item 2)", () => {
  it("swaps a coin for at least 99.5% of its face value, decimals adjusted", () => {
    expect(planEntry(coins({ 1: { balanceRaw: 1_000n * 10n ** 18n } }), opts)).toEqual({
      index: 1,
      amountIn: 1_000n * 10n ** 18n,
      minOut: 995_000_000n,
    });
    expect(planEntry(coins({ 0: { balanceRaw: 1_000_000_000n } }), opts)?.minOut).toBe(995_000_000n);
    // Dust rounds the floor up, never down.
    expect(planEntry(coins({ 3: { balanceRaw: 10n ** 18n + 1n } }), opts)?.minOut).toBe(995_001n);
  });

  it("splits a large balance into capped swaps, and keeps to the day's limit", () => {
    expect(planEntry(coins({ 0: { balanceRaw: 30_000_000_000n } }), opts)?.amountIn).toBe(10_000_000_000n);
    expect(planEntry(coins({ 0: { balanceRaw: 30_000_000_000n, limitLeftRaw: 4_000_000_000n } }), opts)?.amountIn).toBe(
      4_000_000_000n,
    );
    expect(planEntry(coins({ 0: { balanceRaw: 30_000_000_000n, limitLeftRaw: 500_000n } }), opts)).toBeNull();
  });

  it("skips a waiting coin for the next, and dust under the minimum", () => {
    expect(
      planEntry(coins({ 0: { balanceRaw: 500_000_000n, waiting: true }, 2: { balanceRaw: 200_000_000n } }), opts)
        ?.index,
    ).toBe(2);
    expect(planEntry(coins({ 0: { balanceRaw: 999_999n } }), opts)).toBeNull();
  });
});

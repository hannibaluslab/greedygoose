import { describe, expect, it } from "vitest";
import { CASH } from "@/config/risk";
import { feeBufferRaw, savingsWithdrawal } from "@/lib/cash";
import { fillRaw } from "@/lib/fuelTank";
import type { RebalanceHolding } from "@/lib/agents/rules/rebalance";
import {
  investTrades,
  topUpCounted,
  topUpInvested,
  topUpsReady,
  waitingRaw,
  type TopUpsState,
} from "@/lib/agents/rules/topUps";

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const price = (n: number) => BigInt(n) * 10n ** 8n;
const none: RebalanceHolding = { sharesRaw: 0n, price: price(1), weightBps: 0n, sellLeftRaw: 0n };
/** `value` dollars of free stock at `p`, `weight` % of the mix. */
const holding = (value: number, p: number, weightPct: number): RebalanceHolding => ({
  sharesRaw: (usd(value) * 10n ** 10n) / price(p),
  price: price(p),
  weightBps: BigInt(Math.round(weightPct * 100)),
  sellLeftRaw: 0n,
});
/** NVIDIA at reserve 5, Apple at 0, Tesla at 6. */
const book = (stocks: Partial<Record<number, RebalanceHolding>>) => ({
  stocks: Array.from({ length: 7 }, (_, r) => stocks[r] ?? none),
});
/** config/risk.ts REBALANCER. */
const opts = { floorBps: 50n, minTradeRaw: usd(20), maxSliceRaw: usd(25_000) };
const DAY = 20_400;
const fresh = (keep: number): TopUpsState => ({
  day: DAY,
  keepRaw: usd(keep),
  readyRaw: 0n,
  todayRaw: 0n,
  markRaw: 0n,
  ownRaw: 0n,
});

describe("investTrades (top-ups into the mix)", () => {
  it("buys the stock furthest below its target first, never past it, and never sells", () => {
    // 50/25/25 at $5,000 / $3,000 / $2,000 and $1,000 in: targets $5,500, $2,750, $2,750.
    const b = book({ 5: holding(5_000, 200, 50), 0: holding(3_000, 250, 25), 6: holding(2_000, 400, 25) });
    expect(investTrades(b, usd(1_000), opts).map((t) => [t.reserveId, t.buy, t.amountIn])).toEqual([
      [5, true, usd(250)],
      [6, true, usd(750)],
    ]);
    expect(investTrades(b, usd(100), opts).map((t) => [t.reserveId, t.amountIn])).toEqual([[6, usd(100)]]);
  });

  it("buys pro rata on target, and into a mix that holds nothing yet", () => {
    const on = book({ 5: holding(5_000, 200, 50), 0: holding(2_500, 250, 25), 6: holding(2_500, 400, 25) });
    expect(investTrades(on, usd(1_000), opts).map((t) => t.amountIn)).toEqual([usd(250), usd(500), usd(250)]);
    const empty = book({ 5: holding(0, 200, 50), 0: holding(0, 250, 50) });
    expect(investTrades(empty, usd(300), opts).map((t) => t.amountIn)).toEqual([usd(150), usd(150)]);
  });

  it("holds each buy to a slice and the minimum, and the rest waits", () => {
    expect(investTrades(book({ 5: holding(0, 200, 100) }), usd(60_000), opts)[0].amountIn).toBe(usd(25_000));
    const seven = book(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((r) => [r, holding(1_000, 100, 100 / 7)])));
    expect(investTrades(seven, usd(100), opts)).toEqual([]); // $14 a stock
  });

  it("asks at least Aave's price less the floor", () => {
    const [t] = investTrades(book({ 6: holding(0, 400, 100) }), usd(750), opts);
    expect(t.minOut).toBe((usd(750) * 10n ** 10n * 9_950n) / (price(400) * 10_000n));
  });
});

describe("topUpCounted (Save's count)", () => {
  it("fills Keep first, then counts all of a top-up", () => {
    const a = topUpCounted(fresh(500), DAY, usd(300), usd(400), usd(700));
    expect(a.countedRaw).toBe(usd(200));
    const b = topUpCounted(a.state, DAY, usd(700), usd(1_000), usd(1_700));
    expect(b.countedRaw).toBe(usd(1_000));
    expect(b.state.todayRaw).toBe(usd(1_200));
  });

  it("leaves the agents' own change out", () => {
    const a = topUpCounted({ ...fresh(0), ownRaw: usd(5) }, DAY, usd(1_000), usd(3), usd(1_003));
    expect(a.countedRaw).toBe(0n);
    expect(topUpCounted(a.state, DAY, usd(1_003), usd(300), usd(1_303)).countedRaw).toBe(usd(298));
  });

  it("takes a fall since the last look out of what's waiting before counting", () => {
    const a = topUpCounted(fresh(0), DAY, usd(1_000), usd(300), usd(1_300));
    // The $300 spent, then $5 arrives: only the $5 waits, and a sale's $300 landing later adds nothing.
    const b = topUpCounted(a.state, DAY, usd(1_000), usd(5), usd(1_005));
    expect(b.state.todayRaw).toBe(usd(5));
    expect(topUpsReady(b.state, DAY + 1, usd(1_305)).readyRaw).toBe(usd(5));
  });
});

describe("topUpsReady, waitingRaw and topUpInvested (Rebalance's check)", () => {
  const counted = topUpCounted(fresh(0), DAY, usd(1_000), usd(300), usd(1_300)).state;

  it("never puts a top-up in the day it arrived", () => {
    expect(topUpsReady(counted, DAY, usd(1_300)).readyRaw).toBe(0n);
    expect(waitingRaw(counted, DAY, usd(1_300))).toEqual({ readyRaw: 0n, todayRaw: usd(300) });
    expect(topUpsReady(counted, DAY + 3, usd(1_300)).readyRaw).toBe(usd(300));
  });

  it("takes a fall out of what's ready first, and a rise never adds", () => {
    const next = topUpCounted(counted, DAY + 1, usd(1_300), usd(200), usd(1_500)).state;
    expect(waitingRaw(next, DAY + 1, usd(9_000))).toEqual({ readyRaw: usd(300), todayRaw: usd(200) });
    expect(waitingRaw(next, DAY + 1, usd(1_100))).toEqual({ readyRaw: 0n, todayRaw: usd(100) });
  });

  it("takes an invest out of what's ready, and doesn't read it as a fall", () => {
    const a = topUpCounted(fresh(500), DAY, usd(500), usd(1_000), usd(1_500));
    const b = topUpsReady(a.state, DAY + 1, usd(1_500));
    expect(b.readyRaw).toBe(usd(1_000));
    const after = topUpInvested(b.state, usd(700), usd(800) - 2n);
    expect(after.readyRaw).toBe(usd(300) - 2n);
    expect(topUpsReady(after, DAY + 1, usd(800) - 2n).readyRaw).toBe(usd(300) - 2n);
  });
});

/*
 * The fuel tank (lib/fuelTank.ts) and Save's count. Save moves only the wallet above its keep-back (CashRules.planSave,
 * CASH.keepBackUsd, the executor's `keepBack`) and counts what it moves as a top-up. So whatever the app brings back
 * from savings into the wallet has to stop at or under the keep-back, or Save would put it back with the next top-up
 * and count it: savings bought into the mix (contracts/test/TopUpsFork.t.sol shows both sides on a Base fork).
 */
describe("the fuel tank and Save's count", () => {
  const keepBackRaw = usd(CASH.keepBackUsd);
  const lots = usd(1_000);

  it("Fill up stops at or under Save's keep-back", () => {
    for (const walletRaw of [0n, 1n, feeBufferRaw / 2n, feeBufferRaw - 1n]) {
      const f = fillRaw({ walletRaw, savingsRaw: lots, saveOn: true });
      expect(f).not.toBeNull();
      expect(walletRaw + (f?.raw ?? 0n)).toBeLessThanOrEqual(keepBackRaw);
    }
  });

  it("a spend from cash leaves the wallet at the tank or lower, never higher than it was", () => {
    expect(feeBufferRaw).toBeLessThanOrEqual(keepBackRaw);
    for (const walletRaw of [0n, feeBufferRaw / 2n, keepBackRaw - 1n, keepBackRaw, keepBackRaw + usd(0.9)]) {
      const w = savingsWithdrawal(usd(20), { walletRaw, savingsRaw: lots, saveOn: true });
      const after = walletRaw + (w?.raw ?? 0n) - usd(20);
      expect(after).toBeLessThanOrEqual(walletRaw > feeBufferRaw ? walletRaw : feeBufferRaw);
    }
  });

  it("a fill comes out of what's waiting, and the next top-up counts only what arrived", () => {
    // $300 counted, network fees drain the wallet to $0.10, Fill up, then $100 arrives and Save sweeps past the keep-back.
    const counted = topUpCounted(fresh(0), DAY, usd(1_000), usd(300), usd(1_300)).state;
    const walletRaw = usd(0.1);
    const fill = fillRaw({ walletRaw, savingsRaw: usd(1_300), saveOn: true })?.raw ?? 0n;
    const swept = walletRaw + fill + usd(100) - keepBackRaw;
    const next = topUpCounted(counted, DAY, usd(1_300) - fill, swept, usd(1_300) - fill + swept).state;
    expect(next.todayRaw).toBe(usd(300) - fill + swept);
    expect(next.todayRaw).toBeLessThan(usd(400));
  });
});

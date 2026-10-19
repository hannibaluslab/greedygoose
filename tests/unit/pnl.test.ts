import { describe, expect, it } from "vitest";
import { blockAt, dayEnds, lastDayEnds, pnlAllTime, pnlSeries, stockGainSeries } from "@/lib/pnl";

const DAY = 86_400;

describe("all-time P&L", () => {
  it("is worth now plus what was taken out, less what was put in: realized and unrealized in one", () => {
    // $2,000 in, $100 sent out, worth $2,000 now: up $100.
    const p = pnlAllTime(
      2_000,
      [
        { t: 0, usd: 2_000 },
        { t: 10 * DAY, usd: -100 },
      ],
      20 * DAY,
    )!;
    expect(p.gainUsd).toBeCloseTo(100, 9);
    expect(p.sinceSec).toBe(0);
  });

  it("divides by the average money in, so money added late doesn't dilute the gain", () => {
    // $1,000 on day 0, $1,000 on day 29 of 30, worth $2,100: average in = 1000 + 1000 × 1/30.
    const p = pnlAllTime(
      2_100,
      [
        { t: 0, usd: 1_000 },
        { t: 29 * DAY, usd: 1_000 },
      ],
      30 * DAY,
    )!;
    expect(p.gainUsd).toBeCloseTo(100, 9);
    expect(p.pct).toBeCloseTo(100 / (1_000 + 1_000 / 30), 9);
    // A plain gain over all money in would say 5%; the average says about 9.7%.
    expect(p.pct!).toBeGreaterThan(0.09);
  });

  it("has nothing to show before any money came in, and no % with nothing to divide by", () => {
    expect(pnlAllTime(0, [], DAY)).toBeNull();
    expect(pnlAllTime(0, [{ t: DAY, usd: -5 }], 2 * DAY)).toBeNull();
    expect(pnlAllTime(10, [{ t: DAY, usd: 10 }], DAY)!.pct).toBe(0);
  });
});

describe("the P&L line", () => {
  const flows = [
    { t: 100, usd: 1_000 },
    { t: 2 * DAY + 100, usd: 500 },
  ];

  it("starts at $0, takes the money in off each day's worth, and ends on the gain now", () => {
    const days = [
      { t: DAY - 1, worthUsd: 1_010 },
      { t: 2 * DAY - 1, worthUsd: 990 },
      { t: 3 * DAY - 1, worthUsd: 1_530 },
    ];
    expect(pnlSeries(days, flows, 1_540, 3 * DAY + 50)).toEqual([0, 10, -10, 30, 40]);
  });

  it("is empty before any money came in", () => {
    expect(pnlSeries([], [], 0, DAY)).toEqual([]);
  });

  it("ends each UTC day on its last second, and finds the block at a time two seconds a block", () => {
    expect(dayEnds(100, 2 * DAY + 5)).toEqual([DAY - 1, 2 * DAY - 1]);
    expect(blockAt(1_000, 5_000n, 1_100)).toBe(4_950n);
    expect(blockAt(2_000, 5_000n, 1_100)).toBe(5_000n);
  });
});

describe("Investments' gain line", () => {
  // Two stocks by reserve id: 10 units of the first all week; 5 of the second bought during day 2.
  const days = [
    { t: DAY - 1, units: [10, 0], prices: [100, 50] },
    { t: 2 * DAY - 1, units: [10, 5], prices: [101, 60] },
    { t: 3 * DAY - 1, units: [10, 5], prices: [99, 62] },
  ];

  it("starts at $0 and counts only price moves on what was held at each day's end", () => {
    // Day 2: +$10 on the first stock; the second was bought that day, so its jump from $50 to $60 isn't counted.
    // Day 3: −$20 on the first, +$10 on the second. Since then: +$10 on the first, −$5 on the second.
    expect(stockGainSeries(days, [100, 61])).toEqual([0, 10, 0, 5]);
  });

  it("never reads a buy as a gain: shares bought today don't count until the day ends", () => {
    const flat = [{ t: DAY - 1, units: [0, 0], prices: [100, 50] }];
    expect(stockGainSeries(flat, [120, 70])).toEqual([0, 0]);
  });

  it("keeps the last price for a stock with no price now, and is empty with no days", () => {
    expect(stockGainSeries(days.slice(0, 1), [110])).toEqual([0, 100]);
    expect(stockGainSeries([], [1])).toEqual([]);
  });

  it("takes the ends of the last n UTC days before today, oldest first", () => {
    expect(lastDayEnds(3, 5 * DAY + 100)).toEqual([3 * DAY - 1, 4 * DAY - 1, 5 * DAY - 1]);
  });
});

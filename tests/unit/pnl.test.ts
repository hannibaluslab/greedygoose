import { describe, expect, it } from "vitest";
import { blockAt, dayEnds, pnlAllTime, pnlSeries } from "@/lib/pnl";

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

import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { backingShares, holdingSplit, portfolioShare, wholePct } from "@/lib/holding";

const shares = (n: number) => parseUnits(n.toFixed(8), 8);

describe("wholePct", () => {
  it("rounds to a whole percent", () => {
    expect(wholePct(0.333)).toBe(33);
    expect(wholePct(0.675)).toBe(68);
  });

  it("never shows 0% for a part that's there", () => {
    expect(wholePct(0.001)).toBe(1);
    expect(wholePct(0.998)).toBe(100);
  });

  it("is 0 and 100 at the ends, and 0 for nothing sensible", () => {
    expect(wholePct(0)).toBe(0);
    expect(wholePct(1)).toBe(100);
    expect(wholePct(-0.2)).toBe(0);
    expect(wholePct(Number.NaN)).toBe(0);
  });
});

describe("holdingSplit", () => {
  it("the boards' NVIDIA: a third backs credit, the rest is free", () => {
    expect(holdingSplit({ backingRaw: shares(3.7), freeRaw: shares(7.5) })).toEqual({ backsPct: 33, freePct: 67 });
  });

  it("adds up to 100 whatever the rounding", () => {
    for (const [backing, free] of [
      [1, 2],
      [2, 1],
      [0.005, 9.995],
      [9.995, 0.005],
      [1, 7],
      [5, 5],
    ]) {
      const s = holdingSplit({ backingRaw: shares(backing), freeRaw: shares(free) });
      expect(s.backsPct + s.freePct).toBe(100);
      expect(s.backsPct).toBeGreaterThan(0);
    }
  });

  it("rounds the backing part as the chip does: a few free shares' dust still reads 100% backs", () => {
    // The preview account's Amazon on 2026-10-14: 6.88 shares, all but dust backing credit.
    expect(holdingSplit({ backingRaw: shares(6.8799), freeRaw: shares(0.0001) })).toEqual({
      backsPct: 100,
      freePct: 0,
    });
  });

  it("all backing or all free", () => {
    expect(holdingSplit({ backingRaw: shares(4), freeRaw: 0n })).toEqual({ backsPct: 100, freePct: 0 });
    expect(holdingSplit({ backingRaw: 0n, freeRaw: shares(4) })).toEqual({ backsPct: 0, freePct: 100 });
  });

  it("nothing held", () => {
    expect(holdingSplit({ backingRaw: 0n, freeRaw: 0n })).toEqual({ backsPct: 0, freePct: 0 });
  });
});

describe("portfolioShare", () => {
  it("is the holding's part of the stocks held", () => {
    expect(portfolioShare(2000, 4600)).toBeCloseTo(2000 / 4600, 12);
    expect(portfolioShare(4600, 4600)).toBe(1);
  });

  it("is null with no stocks, and stays within 0–1", () => {
    expect(portfolioShare(0, 0)).toBeNull();
    expect(portfolioShare(10, 9.99)).toBe(1);
  });
});

describe("backingShares (the shares each stock puts in use, in the note of what you sign)", () => {
  const nvda = { symbol: "NVDAc", decimals: 8 };
  const aapl = { symbol: "AAPLc", decimals: 8 };
  const holdings = [{ symbol: "NVDAc", multiplier: 10n ** 18n }];

  it("lists every stock the batch puts in use, in the batch's order", () => {
    expect(backingShares([{ stock: nvda, raw: 150_000_000n }], holdings)).toEqual([{ symbol: "NVDAc", shares: 1.5 }]);
  });

  it("never drops a line: a stock whose holding isn't read throws", () => {
    expect(() =>
      backingShares(
        [
          { stock: nvda, raw: 1n },
          { stock: aapl, raw: 1n },
        ],
        holdings,
      ),
    ).toThrow(/AAPLc/);
  });
});

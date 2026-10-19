import { describe, expect, it } from "vitest";
import { CREDIT_CAP } from "@/config/risk";
import { freeAll, freeUpLine, planFreeUp, type FreeUpStock } from "@/lib/freeUpPlan";

/*
 * The canvas's own account (Repay + free up, boards 1–8): $500 owed, Amazon 2.17 shares ($500, collateral factor 73%)
 * and Apple 2.40 shares ($600, 78%) both back it. Every figure below is one the boards show.
 */
const position = { totalBackingUsd: 1_100, avgCf: (500 * 0.73 + 600 * 0.78) / 1_100, debtUsd: 500 };
const amazon: FreeUpStock = { symbol: "AMZNc", backingRaw: 2_170_000n, backingUsd: 500, cf: 0.73, paused: false };
const apple: FreeUpStock = { symbol: "AAPLc", backingRaw: 2_400_000n, backingUsd: 600, cf: 0.78, paused: false };
const stocks = [amazon, apple];
const shares = (share: number, held: number) => Math.floor(share * held * 100 + 1e-9) / 100;
const row = (plan: ReturnType<typeof planFreeUp>, symbol: string) => plan.rows.find((r) => r.symbol === symbol)!;

describe("planFreeUp: the boards' numbers", () => {
  it("board 2: with $200 repaid, either stock can come out in full on its own", () => {
    const plan = planFreeUp({ position, repayUsd: 200, repaysAll: false, stocks, picks: [] });
    expect(row(plan, "AMZNc").canAll).toBe(true);
    expect(row(plan, "AAPLc").canAll).toBe(true);
    expect(plan.used).toBe(0);
    expect(plan.creditAfterUsd).toBe(443);
  });

  it("board 3: all of Amazon uses 73% of the limit; Apple shrinks to 0.67 shares; credit $117, Safe", () => {
    const plan = planFreeUp({
      position,
      repayUsd: 200,
      repaysAll: false,
      stocks,
      picks: [{ symbol: "AMZNc", share: 1 }],
    });
    const amzn = row(plan, "AMZNc");
    expect(amzn).toMatchObject({ picked: true, share: 1, all: true, raw: 2_170_000n });
    expect(Math.round(plan.used * 100)).toBe(73);
    expect(shares(row(plan, "AAPLc").maxShare, 2.4)).toBe(0.67);
    expect(plan.after).toBe("safe");
    expect(plan.hfAfter).toBeCloseTo(1.56, 2);
    expect(plan.creditAfterUsd).toBe(117);
    expect(plan.frees).toEqual([{ symbol: "AMZNc", raw: 2_170_000n, all: true }]);
  });

  it("board 4: with $100 repaid, Apple's most is 82% (1.97 shares), Amazon's limit is reached, and it ends in Watch at 1.12", () => {
    const plan = planFreeUp({
      position,
      repayUsd: 100,
      repaysAll: false,
      stocks,
      picks: [{ symbol: "AAPLc", share: 1 }],
    });
    const aapl = row(plan, "AAPLc");
    expect(Math.round(aapl.share * 100)).toBe(82);
    expect(shares(aapl.share, 2.4)).toBe(1.97);
    expect(aapl.all).toBe(false);
    // At its most it signs a hair under, so a price tick before signing doesn't stop it.
    expect(aapl.raw).toBeLessThan(BigInt(Math.floor(aapl.share * 2_400_000)));
    expect(aapl.allNeedsUsd).toBe(75);
    expect(row(plan, "AMZNc").maxShare).toBeCloseTo(0, 9);
    expect(plan.used).toBeCloseTo(1, 9);
    expect(plan.hfAfter).toBeCloseTo(CREDIT_CAP.minHf, 9);
    expect(plan.after).toBe("watch");
    expect(plan.risky).toBe(true);
    expect(plan.creditAfterUsd).toBe(0);
  });

  it("board 5: 25% of Apple is 0.60 shares, 30% of the limit; Amazon up to 1.59 shares; credit $239", () => {
    const plan = planFreeUp({
      position,
      repayUsd: 100,
      repaysAll: false,
      stocks,
      picks: [{ symbol: "AAPLc", share: 0.25 }],
    });
    expect(shares(row(plan, "AAPLc").share, 2.4)).toBe(0.6);
    expect(row(plan, "AAPLc").raw).toBe(600_000n);
    expect(Math.round(plan.used * 100)).toBe(30);
    expect(shares(row(plan, "AMZNc").maxShare, 2.17)).toBe(1.59);
    expect(plan.creditAfterUsd).toBe(239);
    expect(plan.after).toBe("safe");
  });

  it("board 6: free up only, no repay: 0.35 Apple shares use 25%; Amazon up to 1.21 shares; credit $182", () => {
    const plan = planFreeUp({
      position,
      repayUsd: 0,
      repaysAll: false,
      stocks,
      picks: [{ symbol: "AAPLc", share: 0.35 / 2.4 }],
    });
    expect(Math.round(plan.used * 100)).toBe(25);
    expect(shares(row(plan, "AMZNc").maxShare, 2.17)).toBe(1.21);
    expect(plan.creditAfterUsd).toBe(182);
    expect(plan.owedAfterUsd).toBe(500);
  });

  it("board 7: repay all brings every stock back and leaves no credit", () => {
    const plan = planFreeUp({ position, repayUsd: 500, repaysAll: true, stocks, picks: freeAll(stocks) });
    expect(plan.frees).toEqual([
      { symbol: "AMZNc", raw: 2_170_000n, all: true },
      { symbol: "AAPLc", raw: 2_400_000n, all: true },
    ]);
    expect(plan.hfAfter).toBeNull();
    expect(plan.after).toBe("none");
    expect(plan.creditAfterUsd).toBe(0);
  });
});

describe("planFreeUp: the rules", () => {
  it("stocks take the limit in the order they were ticked", () => {
    const appleFirst = planFreeUp({
      position,
      repayUsd: 200,
      repaysAll: false,
      stocks,
      picks: [
        { symbol: "AAPLc", share: 1 },
        { symbol: "AMZNc", share: 1 },
      ],
    });
    expect(row(appleFirst, "AAPLc").all).toBe(true);
    expect(row(appleFirst, "AMZNc").share).toBeCloseTo((497 - 468) / 0.73 / 500, 9);
    expect(appleFirst.hfAfter).toBeCloseTo(CREDIT_CAP.minHf, 9);
  });

  it("never ends under the line, whatever is asked", () => {
    for (const repayUsd of [0, 50, 100, 200, 300, 499]) {
      const plan = planFreeUp({ position, repayUsd, repaysAll: false, stocks, picks: freeAll(stocks) });
      expect(plan.hfAfter! + 1e-9).toBeGreaterThanOrEqual(CREDIT_CAP.minHf);
      expect(plan.after).not.toBe("act");
    }
  });

  it("a paused stock can't be ticked or come out", () => {
    const paused = { ...apple, paused: true };
    const plan = planFreeUp({
      position,
      repayUsd: 200,
      repaysAll: false,
      stocks: [amazon, paused],
      picks: [{ symbol: "AAPLc", share: 1 }],
    });
    expect(row(plan, "AAPLc")).toMatchObject({ picked: false, maxShare: 0, canAll: false, allNeedsUsd: 0 });
    expect(plan.frees).toEqual([]);
    expect(freeAll([amazon, paused]).map((k) => k.symbol)).toEqual(["AMZNc"]);
  });

  it("a stock sold to pay takes its power with it", () => {
    // Paying $200 with Amazon that backs credit: $202 of it leaves backing with the sale.
    const plan = planFreeUp({
      position,
      repayUsd: 200,
      repaysAll: false,
      repayPowerOutUsd: 202 * 0.73,
      stocks: [apple],
      picks: [{ symbol: "AAPLc", share: 1 }],
    });
    expect(row(plan, "AAPLc").share).toBeCloseTo((833 - 202 * 0.73 - 300 * CREDIT_CAP.minHf) / 0.78 / 600, 9);
  });

  it("in Act already, nothing comes out until the repay brings it back over the line", () => {
    const fallen = { ...position, totalBackingUsd: 514.4, avgCf: (320 * 0.73 + 360 * 0.78) / 680 };
    const scaled = { totalBackingUsd: 680, avgCf: fallen.avgCf, debtUsd: 500 };
    const low = [
      { ...amazon, backingUsd: 320 },
      { ...apple, backingUsd: 360 },
    ];
    const none = planFreeUp({ position: scaled, repayUsd: 0, repaysAll: false, stocks: low, picks: freeAll(low) });
    expect(none.frees).toEqual([]);
    const some = planFreeUp({
      position: scaled,
      repayUsd: 200,
      repaysAll: false,
      stocks: low,
      picks: [{ symbol: "AMZNc", share: 1 }],
    });
    expect(some.rows[0].share).toBeGreaterThan(0);
    expect(some.hfAfter! + 1e-9).toBeGreaterThanOrEqual(CREDIT_CAP.minHf);
  });
});

describe("the line under a stock in Free up stocks", () => {
  it("is what comes out with its value beside it, of what backs credit, with no unit", () => {
    expect(freeUpLine(0.0047, 0.0147, 1.63)).toBe("0.0047 ($1.63) of 0.0147");
    expect(freeUpLine(0.0029, 0.0029, 0.99)).toBe("0.0029 ($0.99) of 0.0029");
    expect(freeUpLine(2.5, 4, 500)).toBe("2.5 ($500.00) of 4");
  });

  it("says only 0 of what backs credit when nothing can come out", () => {
    expect(freeUpLine(0, 0.0147, 0)).toBe("0 of 0.0147");
  });
});

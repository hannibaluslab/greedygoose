import { describe, expect, it } from "vitest";
import { autoFill, combinedLoan } from "@/lib/aave/loan";

describe("combinedLoan", () => {
  it("adds power from several stocks", () => {
    const r = combinedLoan({
      collateralUsd: 100,
      avgCf: 0.7,
      debtUsd: 0,
      borrowUsd: 300,
      liquidityUsd: 1e9,
      locks: [
        { key: "NVDAc", usd: 400, cf: 0.7, freeUsd: 400 },
        { key: "AAPLc", usd: 200, cf: 0.78, freeUsd: 500 },
      ],
    });
    // 70 + 280 + 156 = 506
    expect(r.powerUsd).toBeCloseTo(506);
    expect(r.hfAfter).toBeCloseTo(506 / 300);
    expect(r.maxSafe).toBeCloseTo(506 / 1.5);
    expect(r.maxWatch).toBeCloseTo(506 / 1.1);
    expect(r.maxAave).toBeCloseTo(506);
    // Act is the line (Adrian, 2026-10-15): the app's cap stops at 1.12, between the Watch line and Aave's.
    expect(r.maxCredit).toBeCloseTo(506 / 1.12);
    expect(r.maxCredit).toBeLessThan(r.maxWatch);
  });

  it("caps maxCredit by what can be lent and nets what's owed", () => {
    const r = combinedLoan({
      collateralUsd: 1_000,
      avgCf: 0.7,
      debtUsd: 300,
      borrowUsd: 0,
      liquidityUsd: 1e9,
      locks: [],
    });
    expect(r.maxCredit).toBeCloseTo(700 / 1.12 - 300);
    expect(
      combinedLoan({ collateralUsd: 1_000, avgCf: 0.7, debtUsd: 300, borrowUsd: 0, liquidityUsd: 100, locks: [] })
        .maxCredit,
    ).toBe(100);
    // Under the line already: nothing, never negative.
    expect(
      combinedLoan({ collateralUsd: 1_000, avgCf: 0.7, debtUsd: 630, borrowUsd: 0, liquidityUsd: 1e9, locks: [] })
        .maxCredit,
    ).toBe(0);
  });
});

describe("autoFill", () => {
  it("tops up from the highest collateral factor first", () => {
    const out = autoFill({
      collateralUsd: 0,
      avgCf: 0,
      debtUsd: 0,
      borrowUsd: 300,
      lines: [
        { key: "NVDAc", usd: 0, cf: 0.7, freeUsd: 1000 },
        { key: "AAPLc", usd: 0, cf: 0.78, freeUsd: 200 },
      ],
    });
    // need 450 power: AAPL all 200×0.78 = 156, then NVDA (450-156)/0.7 = 420
    expect(out.AAPLc).toBeCloseTo(200);
    expect(out.NVDAc).toBeCloseTo(420);
  });
  it("keeps the user's own choices and adds nothing if already enough", () => {
    const out = autoFill({
      collateralUsd: 0,
      avgCf: 0,
      debtUsd: 0,
      borrowUsd: 100,
      lines: [{ key: "NVDAc", usd: 500, cf: 0.7, freeUsd: 1000 }],
    });
    expect(out.NVDAc).toBe(500);
  });
});

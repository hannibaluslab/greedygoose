import { describe, expect, it } from "vitest";
import { borrowApr, monthlyCost, projectHealth, summarize } from "@/lib/aave/math";
import { RAY, VALUE_PER_USD, WAD } from "@/lib/aave/addresses";

const usd = (n: number) => BigInt(n) * VALUE_PER_USD;

describe("summarize", () => {
  it("handles an empty position", () => {
    const s = summarize({
      riskPremium: 0n, avgCollateralFactor: 0n, healthFactor: 2n ** 256n - 1n,
      totalCollateralValue: 0n, totalDebtValueRay: 0n, activeCollateralCount: 0n, borrowCount: 0n,
    });
    expect(s).toEqual({ collateralUsd: 0, debtUsd: 0, availableUsd: 0, healthFactor: null, avgCf: 0 });
  });
  it("computes available credit from Aave's weighted CF", () => {
    const s = summarize({
      riskPremium: 0n, avgCollateralFactor: (WAD * 78n) / 100n, healthFactor: (WAD * 26n) / 10n,
      totalCollateralValue: usd(1000), totalDebtValueRay: usd(300) * RAY, activeCollateralCount: 1n, borrowCount: 1n,
    });
    expect(s.collateralUsd).toBe(1000);
    expect(s.debtUsd).toBe(300);
    expect(s.availableUsd).toBeCloseTo(480);
    expect(s.healthFactor).toBeCloseTo(2.6);
  });
});

describe("projectHealth", () => {
  it("returns null with no debt and CF*collateral/debt otherwise", () => {
    expect(projectHealth({ collateralUsd: 1000, debtUsd: 0, avgCf: 0.78 })).toBeNull();
    expect(projectHealth({ collateralUsd: 1000, debtUsd: 600, avgCf: 0.78 })).toBeCloseTo(1.3);
  });
});

describe("rates", () => {
  it("adds risk premium to the drawn rate", () => {
    const drawn = (RAY * 6n) / 100n; // 6%
    expect(borrowApr(drawn)).toBeCloseTo(0.06);
    expect(borrowApr(drawn, 1000n)).toBeCloseTo(0.066);
    expect(monthlyCost(600, 0.06)).toBeCloseTo(3);
  });
});

import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";

describe("withdraw limits", () => {
  it("allows everything with no debt", () => {
    expect(maxWithdrawUsd({ collateralUsd: 1000, avgCf: 0.7, debtUsd: 0, cf: 0.7, lockedUsd: 400 })).toBe(400);
  });
  it("keeps HF at 1 with debt", () => {
    // room = 1000*0.7 - 500 = 200 → 200/0.7 ≈ 285.7 of this stock
    const max = maxWithdrawUsd({ collateralUsd: 1000, avgCf: 0.7, debtUsd: 500, cf: 0.7, lockedUsd: 1000 });
    expect(max).toBeCloseTo(285.71, 1);
    expect(healthAfterWithdraw({ collateralUsd: 1000, avgCf: 0.7, debtUsd: 500, cf: 0.7, usd: max })).toBeCloseTo(1, 6);
  });
  it("never below zero when already over", () => {
    expect(maxWithdrawUsd({ collateralUsd: 1000, avgCf: 0.5, debtUsd: 600, cf: 0.5, lockedUsd: 1000 })).toBe(0);
  });
});

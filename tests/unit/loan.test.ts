import { describe, expect, it } from "vitest";
import { planLoan, repayChips } from "@/lib/aave/loan";

const base = { collateralUsd: 0, avgCf: 0, debtUsd: 0, priceUsd: 230, cf: 0.7, freeUsd: 1000, liquidityUsd: 1e9 };

describe("planLoan", () => {
  it("locks just enough to start Safe (HF 1.5)", () => {
    const p = planLoan({ ...base, borrowUsd: 280 });
    // need 1.5 × 280 = 420 of power → 420 / 0.7 = 600 USD of stock
    expect(p.lockUsd).toBeCloseTo(600);
    expect(p.lockFraction).toBeCloseTo(0.6);
    expect(p.hfAfter).toBeCloseTo(1.5);
    expect(p.feasible).toBe(true);
  });
  it("uses existing collateral first", () => {
    const p = planLoan({ ...base, collateralUsd: 1000, avgCf: 0.7, borrowUsd: 200 });
    expect(p.lockUsd).toBe(0);
    expect(p.hfAfter).toBeCloseTo(3.5);
  });
  it("tops up when existing collateral isn't enough", () => {
    const p = planLoan({ ...base, collateralUsd: 300, avgCf: 0.7, debtUsd: 100, borrowUsd: 100 });
    // need 1.5 × 200 = 300 power; have 210 → 90 / 0.7 ≈ 128.57 more
    expect(p.lockUsd).toBeCloseTo(128.57, 1);
    expect(p.hfAfter).toBeCloseTo(1.5);
  });
  it("reports max borrow and refuses too much", () => {
    const p = planLoan({ ...base, borrowUsd: 1000 });
    expect(p.maxBorrowUsd).toBeCloseTo(466.67, 1); // 700 / 1.5
    expect(p.feasible).toBe(false);
    expect(p.reason).toBe("too-much");
  });
  it("respects a higher safety target", () => {
    expect(planLoan({ ...base, borrowUsd: 280, targetHf: 2 }).lockUsd).toBeCloseTo(800);
  });
  it("caps by Aave's USDC liquidity", () => {
    const p = planLoan({ ...base, borrowUsd: 100, liquidityUsd: 50 });
    expect(p.reason).toBe("no-liquidity");
    expect(p.maxBorrowUsd).toBe(50);
  });
  it("flags no collateral at all", () => {
    expect(planLoan({ ...base, freeUsd: 0, borrowUsd: 10 }).reason).toBe("no-collateral");
  });
});

import { autoFill, combinedLoan } from "@/lib/aave/loan";

describe("combinedLoan", () => {
  it("adds power from several stocks", () => {
    const r = combinedLoan({
      collateralUsd: 100, avgCf: 0.7, debtUsd: 0, borrowUsd: 300, liquidityUsd: 1e9,
      locks: [{ key: "NVDAc", usd: 400, cf: 0.7, freeUsd: 400 }, { key: "AAPLc", usd: 200, cf: 0.78, freeUsd: 500 }],
    });
    // 70 + 280 + 156 = 506
    expect(r.powerUsd).toBeCloseTo(506);
    expect(r.hfAfter).toBeCloseTo(506 / 300);
    expect(r.maxSafe).toBeCloseTo(506 / 1.5);
    expect(r.maxWatch).toBeCloseTo(506 / 1.1);
    expect(r.maxAave).toBeCloseTo(506);
  });
});

describe("autoFill", () => {
  it("tops up from the highest collateral factor first", () => {
    const out = autoFill({
      collateralUsd: 0, avgCf: 0, debtUsd: 0, borrowUsd: 300,
      lines: [{ key: "NVDAc", usd: 0, cf: 0.7, freeUsd: 1000 }, { key: "AAPLc", usd: 0, cf: 0.78, freeUsd: 200 }],
    });
    // need 450 power: AAPL all 200×0.78 = 156, then NVDA (450-156)/0.7 = 420
    expect(out.AAPLc).toBeCloseTo(200);
    expect(out.NVDAc).toBeCloseTo(420);
  });
  it("keeps the user's own choices and adds nothing if already enough", () => {
    const out = autoFill({
      collateralUsd: 0, avgCf: 0, debtUsd: 0, borrowUsd: 100,
      lines: [{ key: "NVDAc", usd: 500, cf: 0.7, freeUsd: 1000 }],
    });
    expect(out.NVDAc).toBe(500);
  });
});

describe("repayChips", () => {
  it("offers the board's $100 and $300 when the cash can repay more", () => {
    expect(repayChips(1208.13)).toEqual([100, 300]);
    expect(repayChips(400)).toEqual([100, 300]);
  });
  it("offers a quarter and a half of a smaller amount", () => {
    expect(repayChips(300)).toEqual([75, 150]);
    expect(repayChips(41)).toEqual([10, 20]);
  });
  it("offers nothing extra when All is the only sensible choice", () => {
    expect(repayChips(3)).toEqual([1]);
    expect(repayChips(1)).toEqual([]);
    expect(repayChips(0)).toEqual([]);
  });
});

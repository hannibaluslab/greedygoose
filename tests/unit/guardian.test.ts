import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { inWeekendWindow, planGuardian, planSave } from "@/lib/guardian/plan";
import { buildGuardianPermission, buildRescueCalls, buildAddSavingsCalls, PERIOD } from "@/lib/guardian/permission";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GUARDIAN, SEL } from "@/lib/guardian/config";
import { AAVE } from "@/lib/aave/addresses";
import { USDC } from "@/lib/tokens/registry";

const base = { collateralUsd: 1000, avgCf: 0.7, savingsUsd: 500, capLeftUsd: 500, weekendWindow: false };

describe("planGuardian", () => {
  it("does nothing without debt or when Safe", () => {
    expect(planGuardian({ ...base, debtUsd: 0 })).toMatchObject({ action: "none", reason: "no-debt" });
    expect(planGuardian({ ...base, debtUsd: 400 })).toMatchObject({ action: "none", reason: "healthy" }); // HF 1.75
  });
  it("repays to the target when in Watch", () => {
    const d = planGuardian({ ...base, debtUsd: 600 }); // HF 1.1667
    expect(d.action).toBe("repay");
    if (d.action !== "repay") return;
    // target 1.65 → debt 700/1.65 = 424.24 → repay 175.76
    expect(d.amountUsd).toBeCloseTo(175.76, 1);
    expect(d.hfAfter).toBeCloseTo(1.65, 3);
    expect(d.reason).toBe("watch");
  });
  it("is limited by savings and by the daily cap", () => {
    expect(planGuardian({ ...base, debtUsd: 600, savingsUsd: 50 })).toMatchObject({ action: "repay", amountUsd: 50, limitedBy: "savings" });
    expect(planGuardian({ ...base, debtUsd: 600, capLeftUsd: 20 })).toMatchObject({ action: "repay", amountUsd: 20, limitedBy: "cap" });
    expect(planGuardian({ ...base, debtUsd: 600, savingsUsd: 0 })).toMatchObject({ action: "none", reason: "no-savings" });
    expect(planGuardian({ ...base, debtUsd: 600, capLeftUsd: 0 })).toMatchObject({ action: "none", reason: "no-cap" });
  });
  it("Weekend Shield trims a Safe-but-fragile loan before the freeze", () => {
    // HF 1.556 (Safe) but −15% → 1.32 … floor 1.1 is fine → no action
    expect(planGuardian({ ...base, debtUsd: 450, weekendWindow: true }).action).toBe("none");
    // HF 1.52 Safe; stressed 1.29 ok; make it fragile with a 30% stress
    const d = planGuardian({ ...base, debtUsd: 460, weekendWindow: true, stressDrop: 0.4 });
    expect(d).toMatchObject({ action: "repay", reason: "weekend-shield" });
    // outside the window: nothing
    expect(planGuardian({ ...base, debtUsd: 460, weekendWindow: false, stressDrop: 0.4 }).action).toBe("none");
  });
  it("skips dust repays (gas would cost more than it helps)", () => {
    // In Watch, but only 1 cent of savings left → too small to be worth a transaction.
    expect(planGuardian({ ...base, debtUsd: 600, savingsUsd: 0.01 })).toMatchObject({ action: "none", reason: "too-small" });
  });
});

describe("planSave", () => {
  const usd = (n: number) => BigInt(Math.round(n * 1e6));
  const base = { capLeftRaw: usd(100), savesToday: 0 }; // keep-back $1, minimum $1, 6 a day

  it("saves wallet USDC above the keep-back, never below it", () => {
    expect(planSave({ ...base, walletRaw: usd(41) })).toEqual({ action: "save", amountRaw: usd(40) });
    expect(planSave({ ...base, walletRaw: usd(1.99) })).toEqual({ action: "none", reason: "too-small" });
    expect(planSave({ ...base, walletRaw: usd(2), keepBackRaw: 0n })).toEqual({ action: "save", amountRaw: usd(2) });
  });
  it("stays within today's limit and the daily number of saves", () => {
    expect(planSave({ ...base, walletRaw: usd(500) })).toEqual({ action: "save", amountRaw: usd(100) });
    expect(planSave({ ...base, walletRaw: usd(500), capLeftRaw: 0n })).toEqual({ action: "none", reason: "no-cap" });
    expect(planSave({ ...base, walletRaw: usd(500), savesToday: 6 })).toEqual({ action: "none", reason: "rate" });
    expect(planSave({ ...base, walletRaw: usd(500), savesToday: 6, maxSavesPerDay: 7 }).action).toBe("save");
  });
  it("skips a save the limit would shrink below the minimum", () => {
    expect(planSave({ ...base, walletRaw: usd(500), capLeftRaw: usd(0.5) })).toEqual({ action: "none", reason: "too-small" });
  });
});

describe("inWeekendWindow", () => {
  it("is Friday 14:00–20:00 New York", () => {
    expect(inWeekendWindow(new Date("2026-10-16T18:30:00Z"))).toBe(true); // Fri 14:30 EDT
    expect(inWeekendWindow(new Date("2026-10-16T17:30:00Z"))).toBe(false); // Fri 13:30
    expect(inWeekendWindow(new Date("2026-10-17T00:30:00Z"))).toBe(false); // Fri 20:30
    expect(inWeekendWindow(new Date("2026-10-14T18:30:00Z"))).toBe(false); // Wed
  });
});

describe("permission + calls", () => {
  const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
  const checker = "0x00000000000000000000000000000000000000C1" as const;
  it("builds exactly three checked calls and a daily USDC cap", () => {
    const p = buildGuardianPermission({ account: user, spender: "0x00000000000000000000000000000000000000EE", checker, dailyCapRaw: 50_000_000n, start: 1, end: 2 });
    expect(p.calls.map((c) => [c.target, c.selector, c.checker])).toEqual([
      [GUARDIAN.AAVE_V3_POOL, SEL.withdraw, checker],
      [USDC.address, SEL.approve, checker],
      [AAVE.SPOKE, SEL.repay, checker],
    ]);
    expect(p.spends).toEqual([{ token: USDC.address, allowance: 50_000_000n, unit: PERIOD.Day, multiplier: 1 }]);
    expect(() => buildGuardianPermission({ account: user, spender: user, checker, dailyCapRaw: 0n, start: 1, end: 2 })).toThrow();
  });
  it("period units match the manager's enum (Day = 2, Forever = 5, no Year)", () => {
    expect(PERIOD).toEqual({ Minute: 0, Hour: 1, Day: 2, Week: 3, Month: 4, Forever: 5 });
  });
  it("rescue calls withdraw to the user and repay the user's own loan", () => {
    const [w, a, r] = buildRescueCalls(user, 1_000_000n);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: w.data }).args).toEqual([USDC.address, 1_000_000n, user]);
    expect(decodeFunctionData({ abi: erc20Abi, data: a.data }).args).toEqual([AAVE.SPOKE, 1_000_000n]);
    expect(decodeFunctionData({ abi: spokeAbi, data: r.data }).args).toEqual([7n, 1_000_000n, user]);
  });
  it("add-savings approves the pool exactly then supplies", () => {
    const [a, s] = buildAddSavingsCalls(user, 5_000_000n);
    expect(decodeFunctionData({ abi: erc20Abi, data: a.data }).args).toEqual([GUARDIAN.AAVE_V3_POOL, 5_000_000n]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: s.data }).args).toEqual([USDC.address, 5_000_000n, user, 0]);
  });
});

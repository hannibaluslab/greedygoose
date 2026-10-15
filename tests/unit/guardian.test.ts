import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { inWeekendWindow, planGuardian, planSave, weekendHeadsUp } from "@/lib/guardian/plan";
import { sellTiming } from "@/lib/guardian/sell";
import { CASH_AGENT, PROTECT_SELL, RISK } from "@/config/risk";
import { buildGuardianPermission, buildRescueCalls, buildAddSavingsCalls, PERIOD } from "@/lib/guardian/permission";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GUARDIAN, SEL } from "@/lib/guardian/config";
import { AAVE } from "@/lib/aave/addresses";
import { USDC } from "@/lib/tokens/registry";

/** $1,000 of stock at a 70% collateral factor: $700 of backing power. */
const base = { collateralUsd: 1000, avgCf: 0.7, savingsUsd: 500, capLeftUsd: 500 };
/** What's owed for a health factor on that power. */
const owedAt = (hf: number) => 700 / hf;

describe("Act is the line (Adrian, 2026-10-15)", () => {
  it("says it in config/risk.ts: Protect steps in below the Act line and brings the credit back to Watch at 1.2", () => {
    expect(CASH_AGENT.triggerHf).toBe(RISK.watchMin);
    expect(CASH_AGENT.targetHf).toBe(1.2);
    expect(CASH_AGENT.targetHf).toBeGreaterThan(RISK.watchMin);
    expect(CASH_AGENT.targetHf).toBeLessThan(RISK.safeMin);
    expect(PROTECT_SELL).toMatchObject({ headsUpHf: RISK.watchMin, nowHf: 1.05, targetHf: 1.2 });
  });

  it("does nothing at 1.3 (Watch), however much cash there is", () => {
    expect(planGuardian({ ...base, debtUsd: owedAt(1.3), savingsUsd: 10_000, capLeftUsd: 10_000 })).toMatchObject({ action: "none", reason: "healthy" });
    // …nor anywhere in Watch, down to the line itself
    expect(planGuardian({ ...base, debtUsd: owedAt(1.49) }).action).toBe("none");
    expect(planGuardian({ ...base, debtUsd: owedAt(1.1001) }).action).toBe("none");
  });

  it("acts at 1.05 (Act), repaying just enough to be back in Watch at about 1.2", () => {
    const d = planGuardian({ ...base, debtUsd: owedAt(1.05) }); // owes $666.67
    expect(d).toMatchObject({ action: "repay", reason: "act" });
    if (d.action !== "repay") return;
    // to 1.2: owe 700 / 1.2 = $583.33, so repay $83.33, an eighth of what's owed; back to Safe (1.5) would be $200
    expect(d.amountUsd).toBeCloseTo(83.33, 2);
    expect(d.hfAfter).toBeCloseTo(1.2, 6);
  });

  it("sells only if the cash can't reach 1.2: the sale's timing runs on the health the repay leaves", () => {
    const l = { headsUpHf: 1_100n * 10n ** 15n, nowHf: 1_050n * 10n ** 15n, headsUpDelaySec: 1_800n };
    const wad = (hf: number) => BigInt(Math.round(hf * 1e6)) * 10n ** 12n;
    // Enough cash: the repay brings it to 1.2, and selling waits (Watch is fine).
    const enough = planGuardian({ ...base, debtUsd: owedAt(1.04), savingsUsd: 500 });
    expect(enough).toMatchObject({ action: "repay", hfAfter: expect.closeTo(1.2, 6) });
    if (enough.action === "repay") expect(sellTiming(wad(enough.hfAfter), 0n, 1_000n, false, l).timing).toBe("wait");
    // $3 of cash: the repay leaves it in Act (1.045), deep enough for a sale at once.
    const short = planGuardian({ ...base, debtUsd: owedAt(1.04), savingsUsd: 3 });
    expect(short).toMatchObject({ action: "repay", amountUsd: 3, limitedBy: "savings" });
    if (short.action === "repay") {
      expect(short.hfAfter).toBeLessThan(1.05);
      expect(sellTiming(wad(short.hfAfter), 0n, 1_000n, false, l)).toEqual({ timing: "sell", atOnce: true });
    }
    // No cash at all: nothing to repay with, and the sale goes on its own.
    expect(planGuardian({ ...base, debtUsd: owedAt(1.04), savingsUsd: 0 })).toMatchObject({ action: "none", reason: "no-savings" });
  });
});

describe("planGuardian", () => {
  it("does nothing without debt or when Safe", () => {
    expect(planGuardian({ ...base, debtUsd: 0 })).toMatchObject({ action: "none", reason: "no-debt" });
    expect(planGuardian({ ...base, debtUsd: 400 })).toMatchObject({ action: "none", reason: "healthy" }); // HF 1.75
  });
  it("is limited by savings and by the daily cap", () => {
    const act = owedAt(1.05);
    expect(planGuardian({ ...base, debtUsd: act, savingsUsd: 50 })).toMatchObject({ action: "repay", amountUsd: 50, limitedBy: "savings" });
    expect(planGuardian({ ...base, debtUsd: act, capLeftUsd: 20 })).toMatchObject({ action: "repay", amountUsd: 20, limitedBy: "cap" });
    expect(planGuardian({ ...base, debtUsd: act, savingsUsd: 0 })).toMatchObject({ action: "none", reason: "no-savings" });
    expect(planGuardian({ ...base, debtUsd: act, capLeftUsd: 0 })).toMatchObject({ action: "none", reason: "no-cap" });
  });
  it("skips dust repays (gas would cost more than it helps)", () => {
    // In Act, but only 1 cent of savings left → too small to be worth a transaction.
    expect(planGuardian({ ...base, debtUsd: owedAt(1.05), savingsUsd: 0.01 })).toMatchObject({ action: "none", reason: "too-small" });
  });
});

describe("weekendHeadsUp: Weekend Shield is a card now, never a repay", () => {
  it("before the freeze, warns credit in Watch that a 15% drop would take into Act, with the repay that keeps it in Watch", () => {
    // 1.25 (Watch): −15% → 1.0625, under the Act line
    const h = weekendHeadsUp({ collateralUsd: 1000, avgCf: 0.7, debtUsd: owedAt(1.25), weekendWindow: true });
    expect(h).not.toBeNull();
    expect(h!.stressedHf).toBeCloseTo(1.0625, 4);
    // the stressed health back to 1.1 + 0.1: owe 595 / 1.2 = $495.83, so $64.17 of the $560 owed
    expect(h!.addUsd).toBeCloseTo(64.17, 2);
    // and planGuardian still does nothing for it
    expect(planGuardian({ ...base, debtUsd: owedAt(1.25) }).action).toBe("none");
  });
  it("says nothing outside the window, when the drop leaves it out of Act, or in Act (Protect acts itself)", () => {
    const at = (hf: number, weekendWindow = true) => weekendHeadsUp({ collateralUsd: 1000, avgCf: 0.7, debtUsd: owedAt(hf), weekendWindow });
    expect(at(1.25, false)).toBeNull();
    expect(at(1.4)).toBeNull(); // −15% → 1.19, still Watch
    expect(at(1.05)).toBeNull();
    expect(weekendHeadsUp({ collateralUsd: 1000, avgCf: 0.7, debtUsd: 0, weekendWindow: true })).toBeNull();
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

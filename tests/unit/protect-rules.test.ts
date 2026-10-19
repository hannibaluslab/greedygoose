import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { inWeekendWindow, planProtect, planSave, weekendHeadsUp } from "@/lib/agents/rules/protect";
import { sellsNow } from "@/lib/agents/rules/protectSell";
import { CASH_AGENT, CREDIT_CAP, PROTECT_SELL, RISK } from "@/config/risk";
import { buildAddSavingsCalls } from "@/lib/savings";
import { PERIOD } from "@/lib/agents/permissions";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

/** $1,000 of stock at a 70% collateral factor: $700 of backing power. */
const base = { totalBackingUsd: 1000, avgCf: 0.7, savingsUsd: 500, capLeftUsd: 500 };
/** What's owed for a health factor on that power. */
const owedAt = (hf: number) => 700 / hf;

describe("Protect's line (Adrian, 2026-10-19)", () => {
  it("says it in config/risk.ts: Protect acts below 1.03 and brings the credit back to 1.12, the credit cap's line", () => {
    expect(CASH_AGENT.triggerHf).toBe(1.03);
    expect(CASH_AGENT.triggerHf).toBeLessThan(RISK.watchMin); // Act only warns
    expect(CASH_AGENT.targetHf).toBe(1.12);
    expect(CASH_AGENT.targetHf).toBe(CREDIT_CAP.minHf);
    expect(CASH_AGENT.targetHf).toBeLessThan(RISK.safeMin);
    expect(PROTECT_SELL).toEqual({ floorBps: 300, poolCapUsd: 10_000, maxSliceUsd: 5_000 });
  });

  it("does nothing above the line: 1.3 (Watch), 1.08 (Act, a warning only), however much cash there is", () => {
    expect(planProtect({ ...base, debtUsd: owedAt(1.3), savingsUsd: 10_000, capLeftUsd: 10_000 })).toMatchObject({
      action: "none",
      reason: "healthy",
    });
    expect(planProtect({ ...base, debtUsd: owedAt(1.08) }).action).toBe("none");
    expect(planProtect({ ...base, debtUsd: owedAt(1.0301) }).action).toBe("none");
  });

  it("acts at 1.02, repaying just enough to be back at 1.12", () => {
    const d = planProtect({ ...base, debtUsd: owedAt(1.02) }); // owes $686.27
    expect(d).toMatchObject({ action: "repay", reason: "act" });
    if (d.action !== "repay") return;
    // to 1.12: owe 700 / 1.12 = $625, so repay $61.27, 5/56 of what's owed
    expect(d.amountUsd).toBeCloseTo(61.27, 2);
    expect(d.hfAfter).toBeCloseTo(1.12, 6);
  });

  it("during a rescue, acts above the line too, until 1.12", () => {
    const d = planProtect({ ...base, debtUsd: owedAt(1.06), rescuing: true }); // owes $660.38
    expect(d).toMatchObject({ action: "repay", reason: "act" });
    if (d.action === "repay") expect(d.hfAfter).toBeCloseTo(1.12, 6);
    expect(planProtect({ ...base, debtUsd: owedAt(1.06) }).action).toBe("none"); // no rescue: above the line
    expect(planProtect({ ...base, debtUsd: owedAt(1.12), rescuing: true }).action).toBe("none");
  });

  it("sells only if the cash can't reach 1.12, at once below the line, and on through the rescue above it", () => {
    const l = { triggerHf: 1_030n * 10n ** 15n, targetHf: 1_120n * 10n ** 15n };
    const wad = (hf: number) => BigInt(Math.round(hf * 1e6)) * 10n ** 12n;
    // Enough cash: the repay brings it to 1.12, the rescue ends, and nothing sells.
    const enough = planProtect({ ...base, debtUsd: owedAt(1.02), savingsUsd: 500 });
    expect(enough).toMatchObject({ action: "repay", hfAfter: expect.closeTo(1.12, 6) });
    if (enough.action === "repay") expect(sellsNow(wad(enough.hfAfter), false, false, l)).toBe(false);
    // $3 of cash: the repay leaves it under the line (1.0245): a sale at once.
    const short = planProtect({ ...base, debtUsd: owedAt(1.02), savingsUsd: 3 });
    expect(short).toMatchObject({ action: "repay", amountUsd: 3, limitedBy: "savings" });
    if (short.action === "repay") {
      expect(short.hfAfter).toBeLessThan(1.03);
      expect(sellsNow(wad(short.hfAfter), true, false, l)).toBe(true);
    }
    // $20 of cash: over the line (1.0506) but short of 1.12. Only the rescue sells the rest.
    const over = planProtect({ ...base, debtUsd: owedAt(1.02), savingsUsd: 20 });
    if (over.action === "repay") {
      expect(over.hfAfter).toBeGreaterThan(1.03);
      expect(sellsNow(wad(over.hfAfter), true, false, l)).toBe(true);
      expect(sellsNow(wad(over.hfAfter), false, false, l)).toBe(false);
    }
    // No cash at all: nothing to repay with, and the sale goes on its own.
    expect(planProtect({ ...base, debtUsd: owedAt(1.02), savingsUsd: 0 })).toMatchObject({
      action: "none",
      reason: "no-savings",
    });
  });
});

describe("planProtect", () => {
  it("does nothing without debt or when Safe", () => {
    expect(planProtect({ ...base, debtUsd: 0 })).toMatchObject({ action: "none", reason: "no-debt" });
    expect(planProtect({ ...base, debtUsd: 400 })).toMatchObject({ action: "none", reason: "healthy" }); // HF 1.75
  });
  it("is limited by savings and by what's left of the grant's limit", () => {
    const act = owedAt(1.02);
    expect(planProtect({ ...base, debtUsd: act, savingsUsd: 50 })).toMatchObject({
      action: "repay",
      amountUsd: 50,
      limitedBy: "savings",
    });
    expect(planProtect({ ...base, debtUsd: act, capLeftUsd: 20 })).toMatchObject({
      action: "repay",
      amountUsd: 20,
      limitedBy: "cap",
    });
    expect(planProtect({ ...base, debtUsd: act, savingsUsd: 0 })).toMatchObject({
      action: "none",
      reason: "no-savings",
    });
    expect(planProtect({ ...base, debtUsd: act, capLeftUsd: 0 })).toMatchObject({ action: "none", reason: "no-cap" });
  });
  it("skips dust repays (gas would cost more than it helps)", () => {
    // Under the line, but only 1 cent of savings left → too small to be worth a transaction.
    expect(planProtect({ ...base, debtUsd: owedAt(1.02), savingsUsd: 0.01 })).toMatchObject({
      action: "none",
      reason: "too-small",
    });
  });
});

describe("weekendHeadsUp: Weekend Shield is a card now, never a repay", () => {
  it("before the freeze, warns credit that a 15% drop would take under Aave's line, with the repay that keeps it clear", () => {
    // 1.15 (Watch): −15% → 0.9775, under Aave's line (1.0)
    const h = weekendHeadsUp({ totalBackingUsd: 1000, avgCf: 0.7, debtUsd: owedAt(1.15), weekendWindow: true });
    expect(h).not.toBeNull();
    expect(h!.stressedHf).toBeCloseTo(0.9775, 4);
    // the stressed health back to 1.0 + 0.09 (a rescue's margin): owe 595 / 1.09 = $545.87, so $62.82 of $608.70
    expect(h!.addUsd).toBeCloseTo(62.82, 2);
    // and planProtect still does nothing for it
    expect(planProtect({ ...base, debtUsd: owedAt(1.15) }).action).toBe("none");
  });
  it("says nothing outside the window, when the drop leaves it over Aave's line, or under Protect's (it acts itself)", () => {
    const at = (hf: number, weekendWindow = true) =>
      weekendHeadsUp({ totalBackingUsd: 1000, avgCf: 0.7, debtUsd: owedAt(hf), weekendWindow });
    expect(at(1.15, false)).toBeNull();
    expect(at(1.25)).toBeNull(); // −15% → 1.0625, still over Aave's line
    expect(at(1.02)).toBeNull();
    expect(weekendHeadsUp({ totalBackingUsd: 1000, avgCf: 0.7, debtUsd: 0, weekendWindow: true })).toBeNull();
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
    expect(planSave({ ...base, walletRaw: usd(500), capLeftRaw: usd(0.5) })).toEqual({
      action: "none",
      reason: "too-small",
    });
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

describe("permission period and savings calls", () => {
  const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
  it("period units match the manager's enum (Day = 2, Forever = 5, no Year)", () => {
    expect(PERIOD).toEqual({ Minute: 0, Hour: 1, Day: 2, Week: 3, Month: 4, Forever: 5 });
  });
  it("add-savings approves the pool exactly then supplies", () => {
    const [a, s] = buildAddSavingsCalls(user, 5_000_000n);
    expect(decodeFunctionData({ abi: erc20Abi, data: a.data }).args).toEqual([PROTOCOLS.AAVE_V3_POOL, 5_000_000n]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: s.data }).args).toEqual([USDC.address, 5_000_000n, user, 0]);
  });
});

import { describe, expect, it } from "vitest";
import { CREDIT_CAP, RISK } from "@/config/risk";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { FREE_UP_BLOCKED, FREE_UP_FLOOR, freeUpCheck } from "@/lib/freeUp";
import { statusFor } from "@/lib/risk/status";

/*
 * Free up shares (UnlockSheet) on lib/freeUp.ts: Act is the line (Adrian, 2026-10-15). Its MAX keeps the health at
 * 1.12, an amount that would end in Act is blocked with one line and no tick, and Watch keeps D2's tick.
 */

const ONE = 10n ** 18n; // uiMultiplier: one share per token
/** 8 NVIDIA at $250 back the credit at 70%: $2,000 in use. */
const holding = { lockedRaw: 800_000_000n, lockedUsd: 2_000, priceUsd: 250, multiplier: ONE };
const owing = (debtUsd: number) => ({ collateralUsd: 2_000, avgCf: 0.7, debtUsd });
/** `usd` of NVIDIA in raw units at $250. */
const rawFor = (usd: number) => BigInt(Math.round((usd / 250) * 1e8));
const check = (debtUsd: number, usd: number, all = false) =>
  freeUpCheck({ position: owing(debtUsd), holding, decimals: 8, cf: 0.7, amountRaw: all ? holding.lockedRaw : rawFor(usd), all });

describe("freeUpCheck: Free up stops at the cap's line", () => {
  it("with nothing owed, all of it comes out, with no line and no tick", () => {
    const c = check(0, 0, true);
    expect(c).toMatchObject({ canAll: true, maxUsd: 2_000, maxShares: 8, tooMuch: false, after: "none", risky: false, line: null, ok: true });
  });

  it("its MAX keeps the health at 1.12, in Watch, and asks for D2's tick", () => {
    // Owing $800 (health 1.75): (1,400 − 800 × 1.12) ÷ 0.7 = $720 can come out.
    const max = check(800, 0);
    expect(max.canAll).toBe(false);
    expect(max.maxUsd).toBeCloseTo(720, 9);
    expect(max.maxShares).toBeCloseTo(2.88, 9);
    const at = check(800, 720);
    expect(at.hfAfter!).toBeCloseTo(CREDIT_CAP.minHf, 9);
    expect(at).toMatchObject({ after: "watch", tooMuch: false, endsInAct: false, risky: true, line: null, ok: true });
    // Under Safe's room: no tick.
    expect(check(800, 100)).toMatchObject({ after: "safe", risky: false, ok: true });
  });

  it("past the cap but still in Watch: more than can come out, in one line", () => {
    // $731.43 out ends at 1.11, between the cap and the Act line.
    const c = check(800, 731.43);
    expect(statusFor(c.hfAfter)).toBe("watch");
    expect(c).toMatchObject({ tooMuch: true, endsInAct: false, risky: false, ok: false, line: "That’s more than you can free up while you owe $800.00." });
  });

  it("an amount that would end in Act is blocked with one plain line, never a tick", () => {
    const c = check(800, 800); // (1,400 − 560) ÷ 800 = 1.05
    expect(c).toMatchObject({ after: "act", endsInAct: true, risky: false, ok: false, line: FREE_UP_BLOCKED.act });
    expect(FREE_UP_BLOCKED.act).toBe("That would put your credit in Act. Free up less, or repay some first.");
  });

  it("already in Act, or under the cap's line: nothing comes out, and only one line says so", () => {
    for (const debt of [1_300 /* 1.077, Act */, 1_255 /* 1.115, Watch under the cap */]) {
      expect(check(debt, 0)).toMatchObject({ maxUsd: 0, maxShares: 0, line: FREE_UP_BLOCKED["needs-all"], ok: false });
      // With an amount typed it's still that one line, not "Free up less" too.
      expect(check(debt, 10)).toMatchObject({ line: FREE_UP_BLOCKED["needs-all"], ok: false, risky: false });
    }
    expect(FREE_UP_BLOCKED["needs-all"]).toBe("Your credit needs all of these shares. Repay some first to free them up.");
  });

  it("is the line the sheet allowed before, moved: 99.5% of Aave's limit ended deep in Act", () => {
    const aave = maxWithdrawUsd({ ...owing(800), cf: 0.7, lockedUsd: 2_000 });
    expect(statusFor(healthAfterWithdraw({ ...owing(800), cf: 0.7, usd: aave * 0.995 }))).toBe("act");
    expect(check(800, aave * 0.995)).toMatchObject({ endsInAct: true, ok: false });
  });

  it("its batch is checked on Aave's own health after it: in Act, it stops with the same words", () => {
    expect(FREE_UP_FLOOR).toEqual({ minHf: RISK.watchMin, stop: FREE_UP_BLOCKED.act });
  });

  it("keeps protocol words off screen", () => {
    for (const line of Object.values(FREE_UP_BLOCKED)) expect(line).not.toMatch(/borrow|loan|lock|aave|collateral|health/i);
  });
});

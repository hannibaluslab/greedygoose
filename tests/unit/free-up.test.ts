import { describe, expect, it } from "vitest";
import { RISK } from "@/config/risk";
import { FREE_UP_BLOCKED, FREE_UP_FLOOR } from "@/lib/freeUp";

/* What can come out is lib/freeUpPlan.ts (tests/unit/free-up-plan.test.ts); here, the line every take-out is held to. */
describe("Free up's line", () => {
  it("its batch is checked on Aave's own health after it: in Act, it stops with one plain line", () => {
    expect(FREE_UP_FLOOR).toEqual({ minHf: RISK.watchMin, stop: FREE_UP_BLOCKED.act });
    expect(FREE_UP_BLOCKED.act).toBe("That would put your credit in Act. Free up less, or repay some first.");
  });

  it("keeps protocol words off screen", () => {
    for (const line of Object.values(FREE_UP_BLOCKED))
      expect(line).not.toMatch(/borrow|loan|lock|aave|collateral|health/i);
  });
});

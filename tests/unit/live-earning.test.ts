import { describe, expect, it } from "vitest";
import { liveDecimals, liveEarnedUsd, liveText } from "@/lib/liveEarning";

describe("the Yield card's live counter", () => {
  it("carries the total read forward at the APR on the savings, linearly, and restarts from each read", () => {
    expect(liveEarnedUsd(1.5, 1000, 0.04, 0)).toBe(1.5);
    expect(liveEarnedUsd(1.5, 1000, 0.04, 31_536_000)).toBeCloseTo(41.5, 9);
    expect(liveEarnedUsd(0, 1000, 0.04, 86_400)).toBeCloseTo(40 / 365, 9);
  });

  it("counts slower on less cash, holds still with no savings, and never goes backwards", () => {
    expect(liveEarnedUsd(0, 100, 0.04, 86_400)).toBeCloseTo(4 / 365, 9);
    expect(liveEarnedUsd(0.25, 0, 0.04, 100)).toBe(0.25);
    expect(liveEarnedUsd(0.25, 1000, 0.04, -5)).toBe(0.25);
  });

  it("shows enough digits for the last one to move about once a second", () => {
    expect(liveDecimals(10_952, 0.04)).toBe(5);
    expect(liveDecimals(0.99, 0.04)).toBe(8);
    expect(liveDecimals(0, 0.04)).toBe(2);
    expect(liveText(10_952.123456, 5)).toBe("$10,952.12346");
    expect(liveText(0.99, 8)).toBe("$0.99000000");
  });
});

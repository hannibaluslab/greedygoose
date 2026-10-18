import { describe, expect, it } from "vitest";
import { liveDecimals, liveSavingsUsd, liveText } from "@/lib/liveEarning";

describe("the Yield card's live counter", () => {
  it("carries the balance read forward at the APR, linearly, and restarts from each read", () => {
    expect(liveSavingsUsd(1000, 0.04, 0)).toBe(1000);
    expect(liveSavingsUsd(1000, 0.04, 31_536_000)).toBeCloseTo(1040, 9);
    expect(liveSavingsUsd(1000, 0.04, 86_400)).toBeCloseTo(1000 + 40 / 365, 9);
  });

  it("counts nothing while nothing earns, and never backwards", () => {
    expect(liveSavingsUsd(0, 0.04, 100)).toBe(0);
    expect(liveSavingsUsd(1000, 0.04, -5)).toBe(1000);
  });

  it("shows enough digits for the last one to move about once a second", () => {
    expect(liveDecimals(10_952, 0.04)).toBe(5);
    expect(liveDecimals(0.99, 0.04)).toBe(8);
    expect(liveDecimals(0, 0.04)).toBe(2);
    expect(liveText(10_952.123456, 5)).toBe("$10,952.12346");
    expect(liveText(0.99, 8)).toBe("$0.99000000");
  });
});

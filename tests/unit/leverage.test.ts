import { describe, expect, it } from "vitest";
import { leverageOf, leverageText } from "@/lib/leverage";

describe("leverageOf: what you hold ÷ your own money", () => {
  it("the boards' example: $1,200 held with $500 owed is 1.7x", () => {
    expect(leverageOf({ holdUsd: 1_200, owedUsd: 500 })).toBeCloseTo(1_200 / 700, 9);
    expect(leverageText(leverageOf({ holdUsd: 1_200, owedUsd: 500 })!)).toBe("1.7x");
  });

  it("shows only while something is owed, and never when nothing is yours", () => {
    expect(leverageOf({ holdUsd: 1_200, owedUsd: 0 })).toBeNull();
    expect(leverageOf({ holdUsd: 500, owedUsd: 500 })).toBeNull();
    expect(leverageOf({ holdUsd: 400, owedUsd: 500 })).toBeNull();
  });

  it("rounds down to one decimal, so the tag never says more than it is", () => {
    expect(leverageText(2.99)).toBe("2.9x");
    expect(leverageText(3)).toBe("3.0x");
    expect(leverageText(1.04)).toBe("1.0x");
  });
});

import { describe, expect, it } from "vitest";
import { formatSignedPct, formatSignedUsd, formatUsdTrim, stepsNote } from "@/lib/formatting";

describe("formatUsdTrim", () => {
  it("drops cents only when they are zero", () => {
    expect(formatUsdTrim(3)).toBe("$3");
    expect(formatUsdTrim(1.5)).toBe("$1.50");
    expect(formatUsdTrim(4600)).toBe("$4,600");
  });
});

describe("signed changes", () => {
  it("writes a percent change the way the boards do", () => {
    expect(formatSignedPct(0.0142)).toBe("+1.42%");
    expect(formatSignedPct(-0.0058)).toBe("−0.58%");
    expect(formatSignedPct(0)).toBe("+0.00%");
  });

  it("writes a dollar change with thousands and cents", () => {
    expect(formatSignedUsd(38.2)).toBe("+$38.20");
    expect(formatSignedUsd(-1234.5)).toBe("−$1,234.50");
  });

  it("never shows a minus on a change that rounds to zero", () => {
    expect(formatSignedPct(-0.00001)).toBe("+0.00%");
    expect(formatSignedUsd(-0.001)).toBe("+$0.00");
  });
});

describe("stepsNote (the line under a button that opens JAW's sheet more than once)", () => {
  it("says nothing for one step, and counts two or more", () => {
    expect([0, 1].map(stepsNote)).toEqual([null, null]);
    expect([2, 3, 5].map(stepsNote)).toEqual(["2 steps", "3 steps", "5 steps"]);
  });
});

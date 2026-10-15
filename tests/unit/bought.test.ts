import { describe, expect, it } from "vitest";
import { boughtLine, tradedLine } from "@/lib/activity/bought";

describe("boughtLine", () => {
  it("says what arrived, the way F1-6 and F2-7 do", () => {
    expect(boughtLine(0.112, "NVDAc")).toBe("Bought 0.1120 NVDA");
    expect(boughtLine(1.35, "AAPLc", true)).toBe("Bought 1.3500 AAPL with Credit Buy");
  });

  it("leaves the figure out when the receipt couldn't be read", () => {
    expect(boughtLine(null, "TSLAc")).toBe("Bought TSLA");
  });
});

describe("tradedLine", () => {
  it("says what a stock → stock trade sold and what arrived", () => {
    expect(tradedLine(0.0086, "AAPLc", "NVDAc")).toBe("Traded NVDA for 0.0086 AAPL");
    expect(tradedLine(null, "AAPLc", "NVDAc")).toBe("Traded NVDA for AAPL");
  });
});

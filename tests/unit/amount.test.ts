import { describe, expect, it } from "vitest";
import { cleanAmount } from "@/components/gg/kit/AmountInput";
import { amountFontSize } from "@/components/gg/kit/AmountField";

describe("cleanAmount", () => {
  it("keeps digits and one dot, trims decimals", () => {
    expect(cleanAmount("12.345")).toBe("12.34");
    expect(cleanAmount("1.2.3")).toBe("1.23");
    expect(cleanAmount("abc")).toBe("");
    expect(cleanAmount("$1,5")).toBe("1.5");
    expect(cleanAmount("007")).toBe("7");
    expect(cleanAmount(".5")).toBe("0.5");
    expect(cleanAmount("0.123456789", 8)).toBe("0.12345678");
  });
});

describe("amountFontSize", () => {
  it("steps down as the amount lengthens and never goes under 16px", () => {
    expect(amountFontSize("")).toBe(30);
    expect(amountFontSize("300")).toBe(30);
    expect(amountFontSize("1250.5")).toBe(30);
    expect(amountFontSize("12500.50")).toBe(26);
    expect(amountFontSize("1250000.5")).toBe(22);
    expect(amountFontSize("125000000.50")).toBe(19);
    expect(amountFontSize("12500000000000.5")).toBe(16);
  });
});

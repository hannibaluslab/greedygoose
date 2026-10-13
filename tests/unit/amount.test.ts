import { describe, expect, it } from "vitest";
import { cleanAmount } from "@/components/gg/AmountInput";

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

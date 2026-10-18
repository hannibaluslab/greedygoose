import { describe, expect, it } from "vitest";
import { repaySheetSmallPrint } from "@/lib/repay";
import { EQUITIES } from "@/lib/tokens/registry";

const googl = EQUITIES.find((e) => e.symbol === "GOOGLc")!;
const amzn = EQUITIES.find((e) => e.symbol === "AMZNc")!;
const one = 10n ** 18n;
const cashRepay = {
  source: { kind: "cash" },
  amountUsd: 0.5,
  repayRaw: 500_000n,
  coversAll: false,
} as unknown as Parameters<typeof repaySheetSmallPrint>[0];

describe("the Repay sheet's small print names every stock that comes out (D7)", () => {
  it("free up only: the stocks that come out", () => {
    expect(repaySheetSmallPrint(null, [{ stock: googl, amountRaw: 1_140_000n, multiplier: one }])).toBe(
      "In one go: 0.0114 GOOGL comes out of backing your credit.",
    );
  });

  it("cash repay and two stocks: the repay first, then both", () => {
    expect(
      repaySheetSmallPrint(cashRepay, [
        { stock: googl, amountRaw: 1_140_000n, multiplier: one },
        { stock: amzn, amountRaw: 50_000_000n, multiplier: one },
      ]),
    ).toBe(
      "In one go: exactly $0.50 of your cash is repaid, then 0.0114 GOOGL and 0.5 AMZN come out of backing your credit.",
    );
  });

  it("nothing freed: only the repay's own print (none for cash)", () => {
    expect(repaySheetSmallPrint(cashRepay, [])).toBeNull();
  });
});

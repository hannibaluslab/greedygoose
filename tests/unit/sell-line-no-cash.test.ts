import { describe, expect, it } from "vitest";
import { DEFAULT_LINES, repayNote, SELL_LINE_NO_CASH } from "@/lib/agents/lines";

const TODAY = "Only under 1.03, and always first. Your cash pays before any stock is sold.";

describe("GG-19: Protect · sell with no cash, said under Repay from your cash", () => {
  it("is GooseGuard's SELL_LINE_NO_CASH, 1.08", () => {
    expect(SELL_LINE_NO_CASH).toBe(10_800);
  });

  it("with selling on and a line under 1.08, says it sells from 1.08 and that a very fast fall can beat a sale", () => {
    expect(repayNote(DEFAULT_LINES.line, true)).toBe(
      "Only under 1.03, and always first. With no cash, it sells from 1.08, but a very fast fall can beat a sale.",
    );
    expect(repayNote(10_700, true)).toContain("Only under 1.07,");
  });

  it("reads as before with selling off, or a line of 1.08 or more (the account's own line counts then)", () => {
    expect(repayNote(DEFAULT_LINES.line, false)).toBe(TODAY);
    expect(repayNote(10_800, true)).toBe("Only under 1.08, and always first. Your cash pays before any stock is sold.");
    expect(repayNote(11_500, true)).not.toContain("1.08");
  });

  it("keeps to the app's words", () => {
    expect(repayNote(DEFAULT_LINES.line, true)).not.toMatch(/borrow|locked|\broom\b|—/i);
  });
});

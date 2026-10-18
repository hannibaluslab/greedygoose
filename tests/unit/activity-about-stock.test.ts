import { describe, expect, it } from "vitest";
import { aboutStock, type ActivityItem } from "@/lib/activity/decode";

const item = (kind: ActivityItem["kind"], symbol: string, amount = 1): ActivityItem => ({ kind, symbol, amount });

describe("aboutStock: a stock sheet's activity shows the moves where the stock is the main item", () => {
  it("a buy, sale, send or receipt of the stock is about it", () => {
    expect(aboutStock([item("buy", "AAPLc")], "AAPLc")).toBe(true);
    expect(aboutStock([item("sell", "AAPLc"), item("repay", "USDC")], "AAPLc")).toBe(true);
    expect(aboutStock([item("send", "AAPLc")], "AAPLc")).toBe(true);
    expect(aboutStock([item("receive", "AAPLc")], "AAPLc")).toBe(true);
  });

  it("a Credit Buy of another stock that this one backs is not; a Credit Buy of this stock is", () => {
    const creditBuy = [item("supply", "AAPLc"), item("borrow", "USDC"), item("buy", "MSFTc")];
    expect(aboutStock(creditBuy, "AAPLc")).toBe(false);
    expect(aboutStock(creditBuy, "MSFTc")).toBe(true);
    expect(aboutStock([item("supply", "AAPLc"), item("borrow", "USDC"), item("buy", "AAPLc")], "AAPLc")).toBe(true);
  });

  it("credit that went to earn, backed by the stock, is not about the stock", () => {
    expect(aboutStock([item("earn", "USDC"), item("supply", "AAPLc")], "AAPLc")).toBe(false);
  });

  it("the stock coming out of backing is about it, on its own or after a repay", () => {
    expect(aboutStock([item("withdraw", "AAPLc")], "AAPLc")).toBe(true);
    expect(aboutStock([item("repay", "USDC"), item("withdraw", "AAPLc")], "AAPLc")).toBe(true);
  });

  it("the stock going in to back credit on its own is about it; moves of other stocks are not", () => {
    expect(aboutStock([item("supply", "AAPLc"), item("borrow", "USDC")], "AAPLc")).toBe(true);
    expect(aboutStock([item("buy", "NVDAc")], "AAPLc")).toBe(false);
    expect(aboutStock([item("repay", "USDC")], "AAPLc")).toBe(false);
  });
});

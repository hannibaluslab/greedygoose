import { describe, expect, it } from "vitest";
import { leftAfter, leftKey, type TradeSign } from "@/lib/tx/plans";

const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const data = {
  cash: { walletRaw: usdc(0.5), savingsRaw: usdc(1.18), saveOn: true },
  cashUsd: 1.68,
  holdings: [
    { symbol: "META", freeRaw: 1_000n, freeShares: 0.001, freeUsd: 0.31 },
    { symbol: "AAPL", freeRaw: 0n, freeShares: 0, freeUsd: 0 },
  ],
};
const buy = (usd: number) => ({ route: "buy", quote: { amountIn: usdc(usd) } }) as unknown as TradeSign;
const sell = (symbol: string, raw: bigint) =>
  ({ route: "sell", stock: { symbol }, plan: { sharesRaw: raw } }) as unknown as TradeSign;

describe("multi trade: what the editor can still use while other trades are in the list", () => {
  it("nothing else in the list: everything", () => {
    expect(leftAfter(data, [])).toBe(data);
  });

  it("the other buys come out of the cash, wallet first", () => {
    const left = leftAfter(data, [buy(0.2), buy(0.4)]);
    expect(left.cashUsd).toBeCloseTo(1.08, 6);
    expect(left.cash.walletRaw).toBe(0n);
    expect(left.cash.savingsRaw).toBe(usdc(1.08));
  });

  it("the other sales come out of that stock's free shares, in proportion", () => {
    const left = leftAfter(data, [sell("META", 400n)]);
    const meta = left.holdings.find((h) => h.symbol === "META")!;
    expect(meta.freeRaw).toBe(600n);
    expect(meta.freeUsd).toBeCloseTo(0.186, 6);
    expect(left.cashUsd).toBe(1.68);
  });

  it("never below zero, and the key changes only with what's held back", () => {
    const left = leftAfter(data, [buy(5), sell("META", 9_999n)]);
    expect(left.cash.walletRaw).toBe(0n);
    expect(left.cash.savingsRaw).toBe(0n);
    expect(left.holdings[0].freeRaw).toBe(0n);
    expect(leftKey([buy(0.2)])).toBe(leftKey([buy(0.2)]));
    expect(leftKey([buy(0.2)])).not.toBe(leftKey([buy(0.3)]));
  });
});

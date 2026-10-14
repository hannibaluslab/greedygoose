import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { assertAllowed, swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { SELL_BLOCKED, buildSaleCalls, floorPriceUsd, planSell, saleActivity, saleRepayRaw, type SellHolding, type SellPosition } from "@/lib/sell";
import { minOut } from "@/lib/swap/buy";
import type { SellQuote } from "@/lib/swap/sell";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const attacker: `0x${string}` = "0x00000000000000000000000000000000000000ee";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const shares = (n: number) => parseUnits(n.toFixed(8), 8);
const fee = usd(CASH.feeBufferUsd);
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const price = 250;
/** 0.4 NVDA ($100 at Aave's price) sells for $99.50. */
const quote: SellQuote = { venue: "aerodrome", pool: 10, amountIn: shares(0.4), amountOut: usd(99.5) };
const fn = (data: `0x${string}`) => decodeFunctionData({ abi: [...erc20Abi, ...spokeAbi], data }).functionName;
const steps = (calls: { data: `0x${string}`; to: `0x${string}` }[]) => calls.map((c) => (swapOf(c) ? "swap" : fn(c.data)));

/** $1,000 of NVDA backs the credit (CF 70%); 0.1 NVDA is free. */
const holding: SellHolding = { priceUsd: price, freeRaw: shares(0.1), lockedRaw: shares(4), lockedUsd: 1_000, paused: false };
const owing = (debtUsd: number): SellPosition => ({
  collateralUsd: 1_000,
  avgCf: 0.7,
  debtUsd,
  debtRaw: usd(debtUsd),
  healthFactor: debtUsd > 0 ? 700 / debtUsd : null,
});
const tuesday = new Date("2026-10-13T15:00:00Z");
const plan = (from: "free" | "backing" | "repay", q: SellQuote, position = owing(300), h = holding) =>
  planSell({ from, stock: nvda, holding: h, cf: 0.7, position, quote: q, now: tuesday });

describe("buildSaleCalls", () => {
  const sale = (from: "free" | "backing" | "repay", debtRaw = usd(300), q = quote) =>
    buildSaleCalls({ from, user, stock: nvda, quote: q, oraclePriceUsd: price, debtRaw, nowSec: 1_000 });

  it("a backing holding: take the shares out → approve → swap, the same shares all the way", () => {
    const calls = sale("backing");
    expect(steps(calls)).toEqual(["withdraw", "approve", "swap"]);
    expect(calls[0].to).toBe(AAVE.SPOKE);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[0].data }).args).toEqual([BigInt(nvda.reserveId), shares(0.4), user]);
    expect(swapOf(calls[2])!.params.amountIn).toBe(shares(0.4));
  });

  it("repay by selling: take out → approve → swap → approve → repay what the swap is sure to pay, less the fee", () => {
    const calls = sale("repay");
    expect(steps(calls)).toEqual(["withdraw", "approve", "swap", "approve", "repay"]);
    const repayRaw = minOut(usd(99.5)) - fee;
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[3].data }).args).toEqual([AAVE.SPOKE, repayRaw]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[4].data }).args).toEqual([BigInt(USDC.reserveId), repayRaw, user]);
  });

  it("repay by selling more than is owed: a full repay, then the leftover allowance goes back to 0", () => {
    const calls = sale("repay", usd(20));
    expect(steps(calls)).toEqual(["withdraw", "approve", "swap", "approve", "repay", "approve"]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[4].data }).args[1]).toBe(usd(20) + usd(20) / 2000n + 1n);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[5].data }).args).toEqual([AAVE.SPOKE, 0n]);
  });

  it("passes the allowlist for the user only", () => {
    for (const from of ["free", "backing", "repay"] as const) {
      const calls = sale(from);
      expect(assertAllowed(user, calls)).toBe(calls);
      expect(() => assertAllowed(attacker, calls)).toThrow(/unexpected arguments/);
    }
  });

  it("refuses a repay the sale can't pay for", () => {
    expect(() => sale("repay", usd(300), { ...quote, amountIn: shares(0.001), amountOut: usd(0.25) })).toThrow(/positive/);
  });
});

describe("saleRepayRaw", () => {
  it("keeps the fee buffer back and repays no more than all of it", () => {
    expect(saleRepayRaw(usd(10), usd(300))).toBe(usd(10) - fee);
    expect(saleRepayRaw(usd(10), usd(2))).toBe(usd(2) + usd(2) / 2000n + 1n);
    expect(saleRepayRaw(fee, usd(300))).toBe(0n);
  });
});

describe("planSell: free shares", () => {
  it("sells what's free, and the loan doesn't change", () => {
    const p = plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24.9) });
    expect(p.block).toBeUndefined();
    expect(p.maxRaw).toBe(shares(0.1));
    expect(p.before).toBe("safe");
    expect(p.after).toBe("safe");
    expect(p.hfAfter).toBeCloseTo(700 / 300, 6);
    expect(p.repayRaw).toBe(0n);
  });

  it("blocks more than the free shares, under $1, and a pool paying past the floor", () => {
    expect(plan("free", quote).block).toBe("not-free");
    expect(plan("free", { ...quote, amountIn: shares(0.002), amountOut: usd(0.5) }).block).toBe("too-small");
    const far = plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(22) });
    expect(far.block).toBe("price");
    expect(SELL_BLOCKED.price).toMatch(/more than 10% under Aave’s price/);
  });

  it("warns past 2% under Aave's price, and says when the price may move", () => {
    expect(plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24) }).warn).toBe(true);
    expect(plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24.9) }).warn).toBe(false);
    expect(plan("free", quote).priceMayMove).toBe(false);
    const saturday = planSell({ from: "free", stock: nvda, holding, cf: 0.7, position: owing(300), quote, now: new Date("2026-10-17T15:00:00Z") });
    expect(saturday.priceMayMove).toBe(true);
  });
});

describe("planSell: a backing holding (step 3)", () => {
  it("sells only as far as the loan stays Safe", () => {
    // room = 700 − 300 × 1.5 = 250 → $357.14 of NVDA → 1.4285 of the 4 shares in use
    const p = plan("backing", quote);
    expect(p.block).toBeUndefined();
    expect(p.maxRaw).toBe((shares(4) * 357_142n) / 1_000_000n);
    expect(p.hfAfter).toBeCloseTo((700 - 70) / 300, 6);
    expect(p.after).toBe("safe");
    const big = plan("backing", { ...quote, amountIn: shares(1.5), amountOut: usd(373) });
    expect(big.block).toBe("past-safe");
    expect(SELL_BLOCKED["past-safe"]).toMatch(/out of Safe/);
  });

  it("already past Safe: nothing can come out", () => {
    const p = plan("backing", quote, owing(500));
    expect(p.before).toBe("watch");
    expect(p.maxRaw).toBe(0n);
    expect(p.block).toBe("past-safe");
  });

  it("with nothing owed, all of it can go", () => {
    const p = plan("backing", { ...quote, amountIn: shares(4), amountOut: usd(990) }, owing(0));
    expect(p.maxRaw).toBe(shares(4));
    expect(p.block).toBeUndefined();
    expect(p.after).toBe("none");
  });

  it("blocks more than backs the credit, and a paused stock", () => {
    expect(plan("backing", { ...quote, amountIn: shares(5), amountOut: usd(1_240) }).block).toBe("not-backing");
    expect(plan("backing", quote, owing(300), { ...holding, paused: true }).block).toBe("paused");
  });
});

describe("planSell: repay by selling a holding (step 9)", () => {
  it("in Safe: repays what the sale is sure to pay less the fee, and ends healthier", () => {
    const p = plan("repay", quote);
    expect(p.block).toBeUndefined();
    expect(p.repayRaw).toBe(minOut(usd(99.5)) - fee);
    expect(p.hfAfter!).toBeGreaterThan(700 / 300);
    expect(p.after).toBe("safe");
  });

  it("in Watch: works, and ends healthier", () => {
    const p = plan("repay", quote, owing(560));
    expect(p.before).toBe("watch");
    expect(p.block).toBeUndefined();
    expect(p.hfAfter!).toBeCloseTo((700 - 70) / (560 - Number(p.repayRaw) / 1e6), 6);
    expect(p.hfAfter!).toBeGreaterThan(1.25);
  });

  it("near Aave's limit, the shares can't come out before they repay: blocked with why", () => {
    // HF 1.0145: only (700 − 690) / 0.7 × 0.995 ≈ $14.21 of NVDA can come out first.
    const p = plan("repay", quote, owing(690));
    expect(p.before).toBe("act");
    expect(p.block).toBe("near-limit");
    expect(SELL_BLOCKED["near-limit"]).toMatch(/too close to Aave’s limit/);
    const small = plan("repay", { ...quote, amountIn: shares(0.04), amountOut: usd(9.95) }, owing(690));
    expect(small.block).toBeUndefined();
    expect(small.hfAfter!).toBeGreaterThan(700 / 690);
  });

  it("repaying all of it ends with no loan", () => {
    const p = plan("repay", quote, owing(20));
    expect(p.repayRaw).toBe(usd(20) + usd(20) / 2000n + 1n);
    expect(p.hfAfter).toBeNull();
    expect(p.after).toBe("none");
  });

  it("blocks when nothing is owed, and a sale under $1", () => {
    expect(plan("repay", quote, owing(0)).block).toBe("nothing-owed");
    expect(plan("repay", { ...quote, amountIn: shares(0.0036), amountOut: usd(0.89) }).block).toBe("too-small");
  });
});

describe("saleActivity", () => {
  it("lists each move the batch makes", () => {
    expect(saleActivity(nvda, plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24.9) }))).toEqual([
      { kind: "sell", symbol: "NVDAc", amount: 0.1, receivedUsd: 24.9 },
    ]);
    expect(saleActivity(nvda, plan("repay", quote)).map((i) => i.kind)).toEqual(["withdraw", "sell", "repay"]);
    expect(saleActivity(nvda, plan("repay", quote)).at(-1)!.amount).toBeCloseTo(Number(minOut(usd(99.5)) - fee) / 1e6, 6);
  });
});


describe("floorPriceUsd (the review's lowest price)", () => {
  it("is what the sale pays at least, per share: the quote less 1% when that's over Aave's floor", () => {
    // 0.4 NVDA for $99.50: at least $98.505, so $246.26 a share (Aave's floor is $225).
    const p = plan("free", quote);
    expect(p.minOutRaw).toBe(minOut(usd(99.5)));
    expect(floorPriceUsd(p, nvda)).toBeCloseTo(98.505 / 0.4, 6);
  });

  it("is Aave's price less 10% when the pool pays less than that", () => {
    const thin: SellQuote = { ...quote, amountOut: usd(80) };
    expect(floorPriceUsd(plan("free", thin), nvda)).toBeCloseTo(price * 0.9, 6);
  });

  it("is 0 for no shares", () => {
    expect(floorPriceUsd({ minOutRaw: usd(1), sharesRaw: 0n }, nvda)).toBe(0);
  });
});

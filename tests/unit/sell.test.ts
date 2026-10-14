import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, parseUnits } from "viem";
import { swapOf } from "@/lib/allowlist";
import { minOut } from "@/lib/swap/buy";
import { SELL_LIMITS, aaveFloorRaw, buildSellCalls, sellEconomics, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { swapRouter02Abi } from "@/lib/swap/abis";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const shares = (n: number) => parseUnits(n.toFixed(8), 8);
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const price = 250;
/** 0.4 NVDA ($100 at Aave's price) sells for $99.50. */
const quote: SellQuote = { venue: "aerodrome", pool: 10, amountIn: shares(0.4), amountOut: usd(99.5) };

describe("the sale's floor (plan item 7)", () => {
  it("values the shares at Aave's price less the 10% floor, in USDC units", () => {
    // 0.4 × $250 = $100 → $90
    expect(aaveFloorRaw(shares(0.4), nvda, price)).toBe(usd(90));
    expect(aaveFloorRaw(shares(0.4), nvda, 229.15320429)).toBe(usd(82.495153));
  });

  it("is the larger of the quote less 1% and Aave's price less the floor", () => {
    expect(sellMinOut(quote, nvda, price)).toBe(minOut(usd(99.5)));
    const thin = { ...quote, amountOut: usd(90.5) };
    expect(sellMinOut(thin, nvda, price)).toBe(usd(90));
  });

  it("reads the quote's $/share and its discount to Aave's price", () => {
    const e = sellEconomics(quote, nvda, price);
    expect(e.usd).toBe(99.5);
    expect(e.price).toBeCloseTo(248.75, 6);
    expect(e.discount).toBeCloseTo(0.005, 6);
  });
});

describe("buildSellCalls (free shares)", () => {
  it("approves exactly the shares to the router, then swaps them to USDC for the user, floored", () => {
    const [approve, swap] = buildSellCalls({ user, stock: nvda, quote, oraclePriceUsd: price, nowSec: 1_000 });
    expect(approve.to).toBe(nvda.address);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([AERODROME.ROUTER, shares(0.4)]);
    expect(swap.to).toBe(AERODROME.ROUTER);
    const { params } = swapOf(swap)!;
    expect(params).toMatchObject({ tokenIn: nvda.address, tokenOut: USDC.address, recipient: user, amountIn: shares(0.4) });
    expect(params as unknown as { amountOutMinimum: bigint; deadline: bigint }).toMatchObject({ amountOutMinimum: minOut(usd(99.5)), deadline: 1_600n });
  });

  it("goes through Uniswap's multicall with its deadline, Aave's floor included", () => {
    const uni: SellQuote = { venue: "uniswap", pool: 3000, amountIn: shares(0.4), amountOut: usd(90.5) };
    const [approve, swap] = buildSellCalls({ user, stock: nvda, quote: uni, oraclePriceUsd: price, nowSec: 1_000 });
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([UNISWAP.SWAP_ROUTER_02, shares(0.4)]);
    const m = decodeFunctionData({ abi: swapRouter02Abi, data: swap.data });
    expect(m.args[0]).toBe(1_600n);
    expect((swapOf(swap)!.params as unknown as { amountOutMinimum: bigint }).amountOutMinimum).toBe(usd(90));
  });

  it("refuses anything but one of the 7 stocks", () => {
    expect(() => buildSellCalls({ user, stock: USDC, quote, oraclePriceUsd: 1 })).toThrow(/Not a supported stock/);
  });
});

describe("SELL_LIMITS", () => {
  it("mirror the buy's: 10% floor, 2% warning, $1 minimum", () => {
    expect(SELL_LIMITS).toEqual({ floorBps: 1_000, warnDiscount: 0.02, minUsd: 1 });
  });
});

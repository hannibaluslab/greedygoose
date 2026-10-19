import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { bestQuote, buildBuyCalls, minOut, quoteEconomics, signingQuote, type BuyQuote } from "@/lib/swap/buy";
import { aeroRouterAbi, swapRouter02Abi } from "@/lib/swap/abis";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user = "0x000000000000000000000000000000000000dEaD";
const aapl = EQUITIES[0];
const quote: BuyQuote = { venue: "uniswap", pool: 3000, amountIn: 100_000_000n, amountOut: 29_554_521n }; // $100 → 0.2955 AAPLc

describe("quoteEconomics", () => {
  it("computes price per share and premium over oracle", () => {
    const e = quoteEconomics(quote, aapl, 336.65);
    expect(e.usd).toBe(100);
    expect(e.price).toBeCloseTo(338.36, 1);
    expect(e.premium).toBeCloseTo(0.0051, 3);
  });
});

describe("minOut", () => {
  it("applies slippage", () => expect(minOut(10_000n, 100)).toBe(9_900n));
});

describe("buildBuyCalls", () => {
  it("approves exactly amountIn to the router, then swaps to the user before a 10-minute deadline", () => {
    const [approve, swap] = buildBuyCalls({ user, stock: aapl, quote, oraclePriceUsd: 336.65, nowSec: 1_000 });
    expect(approve.to).toBe(USDC.address);
    const a = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    expect(a.functionName).toBe("approve");
    expect(a.args).toEqual([UNISWAP.SWAP_ROUTER_02, 100_000_000n]);

    expect(swap.to).toBe(UNISWAP.SWAP_ROUTER_02);
    const m = decodeFunctionData({ abi: swapRouter02Abi, data: swap.data });
    expect(m.functionName).toBe("multicall");
    const [deadline, inner] = m.args as readonly [bigint, readonly `0x${string}`[]];
    expect(deadline).toBe(1_600n);
    expect(inner).toHaveLength(1);
    const s = decodeFunctionData({ abi: swapRouter02Abi, data: inner[0] });
    expect(s.functionName).toBe("exactInputSingle");
    const params = (
      s.args as readonly [
        { tokenIn: string; tokenOut: string; fee: number; recipient: string; amountOutMinimum: bigint },
      ]
    )[0];
    expect(params.tokenIn).toBe(USDC.address);
    expect(params.tokenOut).toBe(aapl.address);
    expect(params.fee).toBe(3000);
    expect(params.recipient).toBe(user);
    expect(params.amountOutMinimum).toBe(minOut(29_554_521n));
  });
  it("refuses non-equity outputs", () => {
    expect(() => buildBuyCalls({ user, stock: USDC, quote, oraclePriceUsd: 1 })).toThrow();
  });
});

describe("the buy's floor against Aave's price (BUY_LIMITS.blockPremium)", () => {
  // $100 of AAPLc at Aave's $300: 10% over is $330 a share, so $100 buys at least 0.30303030 shares (rounded down).
  const atCapRaw = 30_303_030n;
  const floorOf = (q: BuyQuote) => {
    const [, swap] = buildBuyCalls({ user, stock: aapl, quote: q, oraclePriceUsd: 300, nowSec: 1_000 });
    const [, inner] = decodeFunctionData({ abi: swapRouter02Abi, data: swap.data }).args as readonly [
      bigint,
      readonly `0x${string}`[],
    ];
    const params = decodeFunctionData({ abi: swapRouter02Abi, data: inner[0] }).args[0];
    return (params as { amountOutMinimum: bigint }).amountOutMinimum;
  };

  it("never lets a quote at the 10% cap fill over it (the quote less 1% would be 11.1% over)", () => {
    expect(floorOf({ ...quote, amountOut: atCapRaw })).toBe(atCapRaw);
  });
  it("keeps the 1% under a quote 5% over Aave's price, and holds one just under the cap to the cap", () => {
    expect(floorOf({ ...quote, amountOut: 31_746_031n })).toBe(minOut(31_746_031n));
    expect(floorOf({ ...quote, amountOut: 30_500_000n })).toBe(atCapRaw);
  });
  it("keeps the quote less 1% when that is the higher floor", () => {
    expect(floorOf({ ...quote, amountOut: 33_000_000n })).toBe(minOut(33_000_000n));
  });
  it("stops without Aave's price", () => {
    expect(() => buildBuyCalls({ user, stock: aapl, quote, oraclePriceUsd: 0 })).toThrow();
  });
});

describe("aerodrome route", () => {
  const aq: BuyQuote = { venue: "aerodrome", pool: 10, amountIn: 1_000_000_000n, amountOut: 296_475_655n };
  it("approves the Aerodrome router and sets tick spacing + deadline", () => {
    const [approve, swap] = buildBuyCalls({ user, stock: aapl, quote: aq, oraclePriceUsd: 336.65, nowSec: 1_000 });
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([AERODROME.ROUTER, 1_000_000_000n]);
    expect(swap.to).toBe(AERODROME.ROUTER);
    const p = decodeFunctionData({ abi: aeroRouterAbi, data: swap.data }).args[0];
    expect(p.tickSpacing).toBe(10);
    expect(p.deadline).toBe(1_600n);
    expect(p.recipient).toBe(user);
    expect(p.amountOutMinimum).toBe(minOut(296_475_655n));
  });
  it("bestQuote picks the venue with more shares", () => {
    expect(bestQuote([quote, aq, { ...aq, amountOut: 0n }])).toBe(aq);
    expect(bestQuote([])).toBeNull();
  });
});

describe("signingQuote (the pool read again right before Face ID)", () => {
  const shown: BuyQuote = { venue: "aerodrome", pool: 10, amountIn: 300_000_000n, amountOut: 135_000_000n };
  const fresh = (amountOut: bigint): BuyQuote => ({ ...shown, amountOut });

  it("signs on a better fresh quote, so the floor rises with it", () => {
    expect(signingQuote(shown, fresh(136_000_000n))).toEqual(fresh(136_000_000n));
  });
  it("keeps the review's floor when the price slipped but stays above it", () => {
    expect(signingQuote(shown, fresh(134_000_000n))).toBe(shown);
    expect(signingQuote(shown, fresh(minOut(shown.amountOut)))).toBe(shown);
  });
  it('stops when the fresh quote is under the review\'s "at least"', () => {
    expect(signingQuote(shown, fresh(minOut(shown.amountOut) - 1n))).toBeNull();
  });
  it("only compares the same pool and amount", () => {
    expect(signingQuote(shown, { ...fresh(140_000_000n), venue: "uniswap", pool: 3000 })).toBeNull();
    expect(signingQuote(shown, { ...fresh(140_000_000n), amountIn: 1n })).toBeNull();
  });
});

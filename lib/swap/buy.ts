import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { AERODROME, UNISWAP, type Venue } from "./venues";
import { aeroRouterAbi, swapRouter02Abi } from "./abis";
import { assertAllowed } from "@/lib/allowlist";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

/** Buy guardrails (CLAUDE.md › Buy stocks). */
export const BUY_LIMITS = {
  /** Max slippage between quote and execution, in bps. */
  slippageBps: 100,
  /** Warn when the pool price is this far above Aave's oracle price. */
  warnPremium: 0.02,
  /** Block when the pool price is this far above Aave's oracle price. */
  blockPremium: 0.1,
  minUsd: 1,
  /** Swap deadline, seconds from signing. */
  deadlineSec: 600,
} as const;

/** `pool` is the Uniswap fee tier or the Aerodrome tick spacing. */
export type BuyQuote = { venue: Venue; pool: number; amountIn: bigint; amountOut: bigint };

/** Effective $/share paid, and its premium over Aave's oracle price. */
export function quoteEconomics(q: BuyQuote, stock: Pick<ReserveAsset, "decimals">, oraclePriceUsd: number) {
  const usd = Number(q.amountIn) / 10 ** USDC.decimals;
  const shares = Number(q.amountOut) / 10 ** stock.decimals;
  const price = shares > 0 ? usd / shares : Infinity;
  const premium = oraclePriceUsd > 0 ? price / oraclePriceUsd - 1 : Infinity;
  return { usd, shares, price, premium };
}

export const minOut = (amountOut: bigint, slippageBps: number = BUY_LIMITS.slippageBps) =>
  (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

export const bestQuote = (quotes: BuyQuote[]): BuyQuote | null =>
  quotes.filter((q) => q.amountOut > 0n).reduce<BuyQuote | null>((b, q) => (!b || q.amountOut > b.amountOut ? q : b), null);

export type Call = { to: `0x${string}`; data: Hex; value: bigint };

/**
 * Exact-amount approve to the chosen router + exactInputSingle, recipient = the user.
 * Targets come only from the registry; anything else throws before the wallet sees it.
 */
export function buildBuyCalls(p: { user: `0x${string}`; stock: ReserveAsset; quote: BuyQuote; nowSec?: number }): Call[] {
  const { user, stock, quote } = p;
  if (stock.kind !== "equity") throw new Error("Not a supported stock");
  const router = quote.venue === "aerodrome" ? AERODROME.ROUTER : UNISWAP.SWAP_ROUTER_02;
  const approve: Call = {
    to: USDC.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, quote.amountIn] }),
    value: 0n,
  };
  const amountOutMinimum = minOut(quote.amountOut);
  const data =
    quote.venue === "aerodrome"
      ? encodeFunctionData({
          abi: aeroRouterAbi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: USDC.address,
              tokenOut: stock.address,
              tickSpacing: quote.pool,
              recipient: user,
              deadline: BigInt((p.nowSec ?? Math.floor(Date.now() / 1000)) + BUY_LIMITS.deadlineSec),
              amountIn: quote.amountIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      : encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: USDC.address,
              tokenOut: stock.address,
              fee: quote.pool,
              recipient: user,
              amountIn: quote.amountIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
  return assertAllowed([approve, { to: router, data, value: 0n }]);
}

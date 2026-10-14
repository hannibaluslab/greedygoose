import { encodeFunctionData, erc20Abi, type Hex, type PublicClient, type Transport } from "viem";
import { AERODROME, UNISWAP, type Venue } from "./venues";
import { aeroQuoterAbi, aeroRouterAbi, quoterV2Abi, swapRouter02Abi } from "./abis";
import { assertAllowed } from "@/lib/allowlist";
import type { CHAIN } from "@/lib/chain";
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

type Client = PublicClient<Transport, typeof CHAIN>;

/** Quote `amountIn` USDC → `stock` on one pool (Aerodrome tick spacing or Uniswap fee tier). Throws when the pool can't fill it. */
export async function quotePool(client: Client, stock: ReserveAsset, venue: Venue, pool: number, amountIn: bigint): Promise<BuyQuote> {
  const { result } =
    venue === "aerodrome"
      ? await client.simulateContract({
          address: AERODROME.QUOTER,
          abi: aeroQuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: USDC.address, tokenOut: stock.address, amountIn, tickSpacing: pool, sqrtPriceLimitX96: 0n }],
        })
      : await client.simulateContract({
          address: UNISWAP.QUOTER_V2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: USDC.address, tokenOut: stock.address, amountIn, fee: pool, sqrtPriceLimitX96: 0n }],
        });
  return { venue, pool, amountIn, amountOut: result[0] };
}

/** Best quote across Aerodrome tick spacings and Uniswap v3 fee tiers. `null` = no pool can fill it. */
export async function quoteBuy(client: Client, stock: ReserveAsset, amountIn: bigint): Promise<BuyQuote | null> {
  const settled = await Promise.allSettled([
    ...AERODROME.TICK_SPACINGS.map((pool) => quotePool(client, stock, "aerodrome", pool, amountIn)),
    ...UNISWAP.FEE_TIERS.map((pool) => quotePool(client, stock, "uniswap", pool, amountIn)),
  ]);
  return bestQuote(settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
}

/** Shown when the quote read again just before Face ID gives less than the review's "at least". */
export const QUOTE_MOVED = "The price moved since you checked. Look at the new amount, then try again.";

/**
 * The quote to sign with. useBuyQuote refreshes every 15 s only, so the shown quote's pool is read
 * again right before Face ID. The review promised at least `minOut(shown)`: a fresh quote under that
 * returns null (stop, show QUOTE_MOVED). Otherwise the floor is the higher of the two, so it never
 * drops under what the review showed.
 */
export function signingQuote(shown: BuyQuote, fresh: BuyQuote): BuyQuote | null {
  if (fresh.venue !== shown.venue || fresh.pool !== shown.pool || fresh.amountIn !== shown.amountIn) return null;
  if (fresh.amountOut < minOut(shown.amountOut)) return null;
  return fresh.amountOut > shown.amountOut ? fresh : shown;
}

export type Call = { to: `0x${string}`; data: Hex; value: bigint };

/**
 * Exact-amount approve to the chosen router + exactInputSingle, recipient = the user, with the
 * deadline on both venues (Uniswap's through multicall). Targets come only from the registry;
 * anything else throws before the wallet sees it.
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
  const deadline = BigInt((p.nowSec ?? Math.floor(Date.now() / 1000)) + BUY_LIMITS.deadlineSec);
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
              deadline,
              amountIn: quote.amountIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      : encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: "multicall",
          args: [
            deadline,
            [
              encodeFunctionData({
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
              }),
            ],
          ],
        });
  return assertAllowed(user, [approve, { to: router, data, value: 0n }]);
}

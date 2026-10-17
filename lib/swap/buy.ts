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

/**
 * `pool` is the Uniswap fee tier or the Aerodrome tick spacing. A buy spends USDC for shares; a sell
 * (lib/swap/sell.ts) spends shares for USDC, so its amountIn is shares and its amountOut USDC.
 */
export type BuyQuote = { venue: Venue; pool: number; amountIn: bigint; amountOut: bigint };

/** Which way a swap goes: USDC → stock, or stock → USDC. */
export type Side = "buy" | "sell";

const pair = (stock: ReserveAsset, side: Side) =>
  side === "buy"
    ? { tokenIn: USDC.address, tokenOut: stock.address }
    : { tokenIn: stock.address, tokenOut: USDC.address };

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
  quotes
    .filter((q) => q.amountOut > 0n)
    .reduce<BuyQuote | null>((b, q) => (!b || q.amountOut > b.amountOut ? q : b), null);

type Client = PublicClient<Transport, typeof CHAIN>;

/**
 * Quote `amountIn` on one pool (Aerodrome tick spacing or Uniswap fee tier): USDC → `stock` for a buy,
 * `stock` → USDC for a sell. Throws when the pool can't fill it.
 */
export async function quotePool(
  client: Client,
  stock: ReserveAsset,
  venue: Venue,
  pool: number,
  amountIn: bigint,
  side: Side = "buy",
): Promise<BuyQuote> {
  const { result } =
    venue === "aerodrome"
      ? await client.simulateContract({
          address: AERODROME.QUOTER,
          abi: aeroQuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ ...pair(stock, side), amountIn, tickSpacing: pool, sqrtPriceLimitX96: 0n }],
        })
      : await client.simulateContract({
          address: UNISWAP.QUOTER_V2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ ...pair(stock, side), amountIn, fee: pool, sqrtPriceLimitX96: 0n }],
        });
  return { venue, pool, amountIn, amountOut: result[0] };
}

/** Best quote across Aerodrome tick spacings and Uniswap v3 fee tiers, either way. `null` = no pool can fill it. */
export async function quoteSwap(
  client: Client,
  stock: ReserveAsset,
  amountIn: bigint,
  side: Side,
): Promise<BuyQuote | null> {
  const settled = await Promise.allSettled([
    ...AERODROME.TICK_SPACINGS.map((pool) => quotePool(client, stock, "aerodrome", pool, amountIn, side)),
    ...UNISWAP.FEE_TIERS.map((pool) => quotePool(client, stock, "uniswap", pool, amountIn, side)),
  ]);
  return bestQuote(settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
}

export const quoteBuy = (client: Client, stock: ReserveAsset, amountIn: bigint) =>
  quoteSwap(client, stock, amountIn, "buy");

/** A quote's part of a write's key (useTx): a new quote is a new batch, since its floor (`minOut`) comes from amountOut. */
export const quoteKey = (q: BuyQuote) => [q.venue, q.pool, q.amountIn, q.amountOut];

/**
 * Shown when the quote read again while the batch is prepared gives less than the screen's "at least". It can show
 * before any tap (the batch is prepared in the background), so it doesn't ask the user to try again.
 */
export const QUOTE_MOVED = "The price just moved. Check the new amount.";

/**
 * The quote to sign with. useBuyQuote refreshes every 15 s only, so the shown quote's pool is read
 * again while the batch is prepared (at most 30 s before the tap). The review promised at least `minOut(shown)`: a fresh quote under that
 * returns null (stop, show QUOTE_MOVED). Otherwise the floor is the higher of the two, so it never
 * drops under what the review showed.
 */
export function signingQuote(shown: BuyQuote, fresh: BuyQuote): BuyQuote | null {
  if (fresh.venue !== shown.venue || fresh.pool !== shown.pool || fresh.amountIn !== shown.amountIn) return null;
  if (fresh.amountOut < minOut(shown.amountOut)) return null;
  return fresh.amountOut > shown.amountOut ? fresh : shown;
}

export type Call = { to: `0x${string}`; data: Hex; value: bigint };

/** An exact-amount approve of `token` to `spender`. */
export const approveCall = (token: `0x${string}`, spender: `0x${string}`, amount: bigint): Call => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  value: 0n,
});

/**
 * A router's exactInputSingle paying `recipient`, with the deadline on both venues (Uniswap's through multicall).
 * `router` is Aerodrome Slipstream's (either deployment: the same call) or Uniswap's SwapRouter02; `pool` is the tick
 * spacing or the fee tier.
 */
export function exactInputCall(p: {
  venue: Venue;
  router: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  pool: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
}): Call {
  const { tokenIn, tokenOut, recipient, amountIn, amountOutMinimum } = p;
  const data =
    p.venue === "aerodrome"
      ? encodeFunctionData({
          abi: aeroRouterAbi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              tickSpacing: p.pool,
              recipient,
              deadline: p.deadline,
              amountIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      : encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: "multicall",
          args: [
            p.deadline,
            [
              encodeFunctionData({
                abi: swapRouter02Abi,
                functionName: "exactInputSingle",
                args: [
                  { tokenIn, tokenOut, fee: p.pool, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n },
                ],
              }),
            ],
          ],
        });
  return { to: p.router, data, value: 0n };
}

/** A swap's deadline, BUY_LIMITS.deadlineSec from now (or from `nowSec`). */
export const swapDeadline = (nowSec?: number) =>
  BigInt((nowSec ?? Math.floor(Date.now() / 1000)) + BUY_LIMITS.deadlineSec);

/**
 * Exact-amount approve to the chosen router + exactInputSingle, recipient = the user, with the
 * deadline on both venues (Uniswap's through multicall). A buy approves USDC and receives `stock`; a
 * sell approves `stock` and receives USDC. Targets come only from the registry; anything else throws
 * before the wallet sees it.
 */
export function buildSwapCalls(p: {
  user: `0x${string}`;
  stock: ReserveAsset;
  quote: BuyQuote;
  side: Side;
  amountOutMinimum: bigint;
  nowSec?: number;
}): Call[] {
  const { user, stock, quote, amountOutMinimum } = p;
  if (stock.kind !== "equity") throw new Error("Not a supported stock");
  const { tokenIn, tokenOut } = pair(stock, p.side);
  const router = quote.venue === "aerodrome" ? AERODROME.ROUTER : UNISWAP.SWAP_ROUTER_02;
  return assertAllowed(user, [
    approveCall(tokenIn, router, quote.amountIn),
    exactInputCall({
      venue: quote.venue,
      router,
      tokenIn,
      tokenOut,
      pool: quote.pool,
      recipient: user,
      amountIn: quote.amountIn,
      amountOutMinimum,
      deadline: swapDeadline(p.nowSec),
    }),
  ]);
}

/** Buy `stock` with USDC: at least the quote less BUY_LIMITS' slippage. */
export const buildBuyCalls = (p: {
  user: `0x${string}`;
  stock: ReserveAsset;
  quote: BuyQuote;
  nowSec?: number;
}): Call[] => buildSwapCalls({ ...p, side: "buy", amountOutMinimum: minOut(p.quote.amountOut) });

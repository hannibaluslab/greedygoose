import { encodeFunctionData, erc20Abi, parseUnits, type Hex, type PublicClient, type Transport } from "viem";
import { AERODROME, UNISWAP, type Venue } from "./venues";
import { aeroQuoterAbi, aeroRouterAbi, quoterV2Abi, swapRouter02Abi } from "./abis";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
import { assertAllowed } from "@/lib/allowlist";
import type { CHAIN } from "@/lib/chain";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

/** Buy guardrails (CLAUDE.md › Swaps). */
export const BUY_LIMITS = {
  /** Max slippage between quote and execution, in bps. */
  slippageBps: 100,
  /** Warn when the pool price is this far above Aave's oracle price. */
  warnPremium: 0.02,
  /** Block when the pool price is this far above Aave's oracle price. */
  blockPremium: 0.1,
  // The smallest amount that can be typed: no minimum of ours (ruling 2, Oct 17); pools and Aave set their own.
  minUsd: 0.01,
  /** Swap deadline, seconds from signing. */
  deadlineSec: 600,
} as const;

/** What a swap's floor keeps of its quote (the 1% slippage). */
export const SLIP_KEEP = 1 - BUY_LIMITS.slippageBps / 10_000;

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

/**
 * Raw shares that `usdRaw` buys at Aave's oracle price plus BUY_LIMITS' cap (10%), rounded down: the fewest a buy may
 * get. Throws without a price, since the cap can't be worked out.
 */
function aaveCapSharesRaw(usdRaw: bigint, stock: Pick<ReserveAsset, "decimals">, oraclePriceUsd: number): bigint {
  const price = oraclePriceUsd > 0 ? parseUnits(oraclePriceUsd.toFixed(ORACLE_DECIMALS), ORACLE_DECIMALS) : 0n;
  if (price <= 0n) throw new Error("Blocked: no Aave price for the buy's floor");
  const capBps = BigInt(10_000 + Math.round(BUY_LIMITS.blockPremium * 10_000));
  return (usdRaw * 10n ** BigInt(stock.decimals + ORACLE_DECIMALS - USDC.decimals) * 10_000n) / (price * capBps);
}

/**
 * The buy's `amountOutMinimum`: the larger of the quote less 1% and the shares the spend buys at Aave's price plus the
 * 10% cap, so a buy can never fill further over Aave's price than the screen allows (sellMinOut's mirror).
 */
function buyMinOut(quote: BuyQuote, stock: Pick<ReserveAsset, "decimals">, oraclePriceUsd: number): bigint {
  const fromQuote = minOut(quote.amountOut);
  const fromAave = aaveCapSharesRaw(quote.amountIn, stock, oraclePriceUsd);
  return fromQuote > fromAave ? fromQuote : fromAave;
}

/** Buy `stock` with USDC: at least buyMinOut (the quote less 1%, never over Aave's price plus 10%). */
export const buildBuyCalls = (p: {
  user: `0x${string}`;
  stock: ReserveAsset;
  quote: BuyQuote;
  /** Aave's price for `stock`, for the buy's floor. */
  oraclePriceUsd: number;
  nowSec?: number;
}): Call[] => buildSwapCalls({ ...p, side: "buy", amountOutMinimum: buyMinOut(p.quote, p.stock, p.oraclePriceUsd) });

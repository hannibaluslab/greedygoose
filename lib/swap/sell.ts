import { parseUnits } from "viem";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
import { BUY_LIMITS, buildSwapCalls, minOut, type BuyQuote, type Call } from "./buy";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

/** Sell guardrails: the buy's, mirrored (CLAUDE.md › Swaps). Slippage is the buy's 1% (`minOut`). */
export const SELL_LIMITS = {
  /** Never sell more than this far under Aave's oracle price, in bps: the buy blocks this far over it. */
  floorBps: 1_000,
  /** Warn when the pool pays this far under Aave's oracle price. */
  warnDiscount: BUY_LIMITS.warnPremium,
  minUsd: BUY_LIMITS.minUsd,
} as const;

/** A quote for selling: `amountIn` is the stock's raw units, `amountOut` USDC. */
export type SellQuote = BuyQuote;

/** USDC (raw) that `sharesRaw` of `stock` is worth at Aave's oracle price, less SELL_LIMITS' floor. */
export function aaveFloorRaw(sharesRaw: bigint, stock: Pick<ReserveAsset, "decimals">, oraclePriceUsd: number): bigint {
  const price = parseUnits(oraclePriceUsd.toFixed(ORACLE_DECIMALS), ORACLE_DECIMALS);
  const scale = 10n ** BigInt(stock.decimals + ORACLE_DECIMALS - USDC.decimals) * 10_000n;
  return (sharesRaw * price * BigInt(10_000 - SELL_LIMITS.floorBps)) / scale;
}

/**
 * The swap's `amountOutMinimum`: the larger of the quote less 1% and the shares at Aave's price less
 * the floor, so a thin or moved pool can never sell far under Aave's price.
 */
export function sellMinOut(quote: SellQuote, stock: Pick<ReserveAsset, "decimals">, oraclePriceUsd: number): bigint {
  const fromQuote = minOut(quote.amountOut);
  const fromAave = aaveFloorRaw(quote.amountIn, stock, oraclePriceUsd);
  return fromQuote > fromAave ? fromQuote : fromAave;
}

/** USDC the sale pays at the quote, $/share, and how far that is under Aave's oracle price. */
export function sellEconomics(q: SellQuote, stock: Pick<ReserveAsset, "decimals">, oraclePriceUsd: number) {
  const usd = Number(q.amountOut) / 10 ** USDC.decimals;
  const shares = Number(q.amountIn) / 10 ** stock.decimals;
  const price = shares > 0 ? usd / shares : 0;
  const discount = oraclePriceUsd > 0 ? 1 - price / oraclePriceUsd : 1;
  return { usd, shares, price, discount };
}

/**
 * Sell free shares (plan item 7 step 2): exact-amount approve of the stock to the chosen router, then
 * exactInputSingle stock → USDC to the user, floored by sellMinOut. Leo's venues, deadline and allowlist.
 */
export function buildSellCalls(p: {
  user: `0x${string}`;
  stock: ReserveAsset;
  quote: SellQuote;
  oraclePriceUsd: number;
  nowSec?: number;
}): Call[] {
  return buildSwapCalls({ ...p, side: "sell", amountOutMinimum: sellMinOut(p.quote, p.stock, p.oraclePriceUsd) });
}

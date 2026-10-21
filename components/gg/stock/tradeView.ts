"use client";

import { useBuyQuote, useBuyQuoteRaw } from "@/hooks/useBuyQuote";
import { useSellQuote } from "@/hooks/useSell";
import { planTrade, tradeAmount } from "@/lib/trade";
import type { TradeSign } from "@/lib/tx/plans";

/*
 * One trade's live view and what it would sign: the Trade sheet's editor uses them, and so does every row of a multi
 * trade (MultiTrade.tsx), so a row is priced exactly as the editor prices it.
 */

/** What the Trade sheet signs for the route on screen, once it's ready (the quotes and the plan its screen shows). */
export function tradeSign(
  view: ReturnType<typeof planTrade>,
  user: `0x${string}`,
  debtRaw: bigint,
  toPriceUsd: number,
): TradeSign | null {
  if (!view.ready) return null;
  const { route, fromStock, toStock, fromHolding, sellQuote: sq, sellPlan, buyQuote: bq } = view;
  if (route === "buy" && toStock && bq) return { route, user, stock: toStock, quote: bq, oraclePriceUsd: toPriceUsd };
  if (route === "sell" && fromStock && fromHolding && sq && sellPlan)
    return { route, user, stock: fromStock, quote: sq, plan: sellPlan, oraclePriceUsd: fromHolding.priceUsd, debtRaw };
  if (route === "swap" && fromStock && toStock && fromHolding && sq && sellPlan && bq)
    return {
      route,
      user,
      from: fromStock,
      to: toStock,
      sellQuote: sq,
      plan: sellPlan,
      buyQuote: bq,
      oraclePriceUsd: fromHolding.priceUsd,
      toPriceUsd,
      feeFromSale: view.feeFromSale,
    };
  return null;
}

/**
 * The quotes each route needs and the plan from them: the sale's for its shares (debounced), the buy's for the typed
 * dollars (debounced), and a swap's buy for the sale's floor once the sale's quote is in. Nothing is quoted without legs.
 */
export function useTradeView(input: Omit<Parameters<typeof planTrade>[0], "buy" | "sell">, hasLegs: boolean) {
  const a = tradeAmount(input);
  const selling = a.route === "sell" || a.route === "swap";
  const sellQuote = useSellQuote(hasLegs && selling ? a.fromStock : undefined, a.sharesRaw);
  const swapIn = planTrade({ ...input, sell: sellQuote }).buyInRaw;
  const cashBuyQuote = useBuyQuote(hasLegs && a.route === "buy" ? a.toStock : undefined, a.amountUsd);
  const swapBuyQuote = useBuyQuoteRaw(
    hasLegs && a.route === "swap" ? a.toStock : undefined,
    a.route === "swap" ? swapIn : 0n,
  );
  return planTrade({ ...input, sell: sellQuote, buy: a.route === "buy" ? cashBuyQuote : swapBuyQuote });
}

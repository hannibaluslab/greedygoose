"use client";

import { useTx } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { CREDIT_BUY_FALLBACK, useCreditBuyBatch } from "./useCreditBuy";
import { useSigningCash } from "./useSigningCash";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { payFromCash } from "@/lib/cash";
import type { ActivityItem } from "@/lib/activity/decode";
import { creditBuyActivity, type CreditPlan } from "@/lib/creditBuy";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

export const BUY_FALLBACK = "This buy would fail right now — the price may have moved or the stock may be paused. Try again in a moment.";

/** What Activity shows while a buy confirms. */
export const buyActivity = (stock: ReserveAsset, quote: BuyQuote): ActivityItem[] => [
  {
    kind: "buy",
    symbol: stock.symbol,
    amount: Number(quote.amountOut) / 10 ** stock.decimals,
    paidUsd: Number(quote.amountIn) / 10 ** USDC.decimals,
  },
];

/**
 * A buy paid from cash, built right before JAW's sheet: the quote and the cash are read again (useSigningQuote,
 * useSigningCash), and the savings withdrawal it needs goes first in the same batch. The Buy step's and the Trade
 * sheet's cash → stock.
 */
export function useCashBuyBatch() {
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
  return async (p: { user: `0x${string}`; stock: ReserveAsset; quote: BuyQuote }) => {
    const quote = await quoteToSign(p.stock, p.quote);
    return payFromCash(p.user, quote.amountIn, await cashToSign(p.user, quote.amountIn), buildBuyCalls({ user: p.user, stock: p.stock, quote }));
  };
}

/**
 * Buy with cash. Decision 1: when the buy is more than the cash, `credit` (planCredit for the other
 * part, from splitCash) turns it into one batch: withdraw savings, take credit, approve, swap. The quote
 * and the cash are read again right before JAW's sheet.
 */
export function useBuy() {
  const tx = useTx("The buy didn’t go through on Base. Nothing was taken except any network fee.");
  const cashBatch = useCashBuyBatch();
  const creditBatch = useCreditBuyBatch();
  const buy = (p: {
    user: `0x${string}`;
    stock: ReserveAsset;
    quote: BuyQuote;
    credit?: { plan: CreditPlan; confirmedRisk: boolean };
  }) => {
    const { credit } = p;
    return credit
      ? tx.run(p.user, () => creditBatch({ ...p, ...credit }), CREDIT_BUY_FALLBACK, creditBuyActivity({ ...p, plan: credit.plan }))
      : tx.run(p.user, () => cashBatch(p), BUY_FALLBACK, buyActivity(p.stock, p.quote));
  };
  return { ...tx, buy };
}

"use client";

import { useTx } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { CREDIT_BUY_FALLBACK, useCreditBuyBatch } from "./useCreditBuy";
import { useSigningCash } from "./useSigningCash";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { payFromCash } from "@/lib/cash";
import { creditBuyActivity, type CreditPlan } from "@/lib/creditBuy";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

/**
 * Buy with cash. Decision 1: when the buy is more than the cash, `credit` (planCredit for the other
 * part, from splitCash) turns it into one batch: withdraw savings, take credit, approve, swap. The quote
 * and the cash are read again right before JAW's sheet.
 */
export function useBuy() {
  const tx = useTx("The buy didn’t go through on Base. Nothing was taken except any network fee.");
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
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
      : tx.run(
          p.user,
          async () => {
            const quote = await quoteToSign(p.stock, p.quote);
            return payFromCash(p.user, quote.amountIn, await cashToSign(p.user, quote.amountIn), buildBuyCalls({ ...p, quote }));
          },
          "This buy would fail right now — the price may have moved or the stock may be paused. Try again in a moment.",
          [{
            kind: "buy",
            symbol: p.stock.symbol,
            amount: Number(p.quote.amountOut) / 10 ** p.stock.decimals,
            paidUsd: Number(p.quote.amountIn) / 10 ** USDC.decimals,
          }],
        );
  };
  return { ...tx, buy };
}

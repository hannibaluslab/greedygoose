"use client";

import { useTx } from "./useTx";
import { cashBuyPlan, useCashBuyBatch } from "./useBuy";
import { useSigningQuote } from "./useBuyQuote";
import { salePlan, useSaleBatch } from "./useSell";
import { useSigningCash } from "./useSigningCash";
import { TRADE_COPY } from "@/lib/trade";
import { swapPlan, type TradeSign } from "@/lib/tx/plans";

/**
 * The Trade sheet's one write path: one useTx, one batch per route, prepared while the sheet is idle from what it
 * would sign now (`input`, null while it can't), so `sign()` opens JAW's sheet straight from the tap. cash → stock is
 * the Buy step's batch (useCashBuyBatch) and stock → cash the free-shares sale (useSaleBatch), unchanged. stock →
 * stock reads both quotes again on their pools (never under the screen's floors), checks the buy still spends no more
 * than the sale's floor, then builds the sale and the buy in one batch (buildTradeCalls). When the cash pays the fee,
 * the cash is read again too, and a savings withdrawal goes first if the wallet can't be counted on for the fee.
 */
export function useTrade(input: TradeSign | null) {
  const cashBuy = useCashBuyBatch();
  const sale = useSaleBatch();
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
  const plan = !input
    ? null
    : input.route === "buy"
      ? cashBuyPlan(input, cashBuy)
      : input.route === "sell"
        ? salePlan(input, sale)
        : swapPlan(input, { quoteToSign, cashToSign });
  return useTx(TRADE_COPY.failedOnChain, plan);
}

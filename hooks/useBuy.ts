"use client";

import { txKey, useTx, type TxPlan } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { creditBuyPlan, useCreditBuyBatch } from "./useCreditBuy";
import { useSigningCash } from "./useSigningCash";
import { buildBuyCalls, quoteKey, type BuyQuote } from "@/lib/swap/buy";
import { payFromCash } from "@/lib/cash";
import type { ActivityItem } from "@/lib/activity/decode";
import type { CreditPlan } from "@/lib/creditBuy";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

const BUY_FALLBACK = "This buy would fail right now — the price may have moved or the stock may be paused. Try again in a moment.";

/** What Activity shows while a buy confirms. */
const buyActivity = (stock: ReserveAsset, quote: BuyQuote): ActivityItem[] => [
  {
    kind: "buy",
    symbol: stock.symbol,
    amount: Number(quote.amountOut) / 10 ** stock.decimals,
    paidUsd: Number(quote.amountIn) / 10 ** USDC.decimals,
  },
];

type CashBuyInput = { user: `0x${string}`; stock: ReserveAsset; quote: BuyQuote };

/**
 * A buy paid from cash, built from fresh reads before JAW's sheet: the quote and the cash are read again
 * (useSigningQuote, useSigningCash), and the savings withdrawal it needs goes first in the same batch. The Buy step's
 * and the Trade sheet's cash → stock.
 */
export function useCashBuyBatch() {
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
  return async (p: CashBuyInput) => {
    const quote = await quoteToSign(p.stock, p.quote);
    return payFromCash(p.user, quote.amountIn, await cashToSign(p.user, quote.amountIn), buildBuyCalls({ user: p.user, stock: p.stock, quote }));
  };
}

/** What a cash buy signs (useTx): keyed by the account, the stock and the quote on screen. */
export const cashBuyPlan = (p: CashBuyInput, batch: ReturnType<typeof useCashBuyBatch>): TxPlan => ({
  key: txKey("buy", p.user, p.stock.symbol, quoteKey(p.quote)),
  user: p.user,
  calls: () => batch(p),
  fallback: BUY_FALLBACK,
  activity: buyActivity(p.stock, p.quote),
});

type BuyInput = CashBuyInput & { credit?: { plan: CreditPlan; confirmedRisk: boolean } };

/**
 * Buy with cash. Decision 1: when the buy is more than the cash, `credit` (planCredit for the other part, from
 * splitCash) turns it into one batch: withdraw savings, take credit, approve, swap. `input` is what the Buy step would
 * sign now (null while it can't): its batch is prepared while the step is idle, with the quote and the cash read
 * again, so `sign()` opens JAW's sheet straight from the tap.
 */
export function useBuy(input: BuyInput | null) {
  const cashBatch = useCashBuyBatch();
  const creditBatch = useCreditBuyBatch();
  const plan = !input
    ? null
    : input.credit
      ? creditBuyPlan({ ...input, ...input.credit }, creditBatch)
      : cashBuyPlan(input, cashBatch);
  return useTx("The buy didn’t go through on Base. Nothing was taken except any network fee.", plan);
}

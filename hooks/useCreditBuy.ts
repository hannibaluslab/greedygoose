"use client";

import { TxStop, useTx } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { useSigningCash } from "./useSigningCash";
import { buildCreditBuyCalls, creditBuyActivity, creditBuyStop, type CreditPlan } from "@/lib/creditBuy";
import type { BuyQuote } from "@/lib/swap/buy";
import type { ReserveAsset } from "@/lib/tokens/registry";

export type CreditBuyInput = {
  user: `0x${string}`;
  stock: ReserveAsset;
  /** The quote the screen shows; its amountIn is the credit plus what cash pays. */
  quote: BuyQuote;
  /** planCredit for the credit the screen shows. */
  plan: CreditPlan;
  /** The extra confirmation when it ends in Watch or Act (D2). */
  confirmedRisk: boolean;
};

export const CREDIT_BUY_FALLBACK =
  "This Credit Buy would fail right now — the price or Aave’s limits may have moved. Try a smaller amount in a moment.";

/**
 * The Credit Buy batch, built right before JAW's sheet: the screen's blocks and risk tick
 * still hold, and the quote and the cash are read again (useSigningQuote, useSigningCash) before
 * buildCreditBuyCalls. Cash pays what the quote spends past the credit, and the network fee.
 */
export function useCreditBuyBatch() {
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
  return async (p: CreditBuyInput) => {
    const stop = creditBuyStop(p.plan, p.confirmedRisk);
    if (stop) throw new TxStop(stop);
    const quote = await quoteToSign(p.stock, p.quote);
    const cash = await cashToSign(p.user, quote.amountIn - p.plan.creditRaw);
    return buildCreditBuyCalls({ user: p.user, stock: p.stock, quote, creditRaw: p.plan.creditRaw, backing: p.plan.backing, cash });
  };
}

/**
 * Credit Buy (plan item 3): take credit and buy a stock in one batch, so the USDC never sits in
 * the wallet. Status before → after and the extra confirmation come from `plan` (planCredit).
 */
export function useCreditBuy() {
  const tx = useTx("The Credit Buy didn’t go through on Base. Nothing moved except any network fee.");
  const batch = useCreditBuyBatch();
  const creditBuy = (p: CreditBuyInput) => tx.run(p.user, () => batch(p), CREDIT_BUY_FALLBACK, creditBuyActivity(p));
  return { ...tx, creditBuy };
}

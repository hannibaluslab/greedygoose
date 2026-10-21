"use client";

import { useTx } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { useSigningCash } from "./useSigningCash";
import { MULTI_COPY } from "@/lib/trade";
import { multiTradePlan, type TradeSign } from "@/lib/tx/plans";

/**
 * Multi trade's one write path: one useTx for the whole list, prepared while the list shows from what it would sign
 * now (`signs`, null while any row isn't ready or the rows can't go together), so the tap opens JAW's sheet once for
 * every trade. Every quote and the cash are read again as the batch is built (multiTradeBatch).
 */
export function useMultiTrade(user: `0x${string}`, signs: readonly TradeSign[] | null) {
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
  return useTx(MULTI_COPY.failedOnChain, signs ? multiTradePlan(user, signs, { quoteToSign, cashToSign }) : null);
}

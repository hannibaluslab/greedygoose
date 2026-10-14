"use client";

import { useTx } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { payFromCash, type Cash } from "@/lib/cash";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

export function useBuy() {
  const tx = useTx("The buy didn’t go through on Base. Nothing was taken except any network fee.");
  const quoteToSign = useSigningQuote();
  const buy = (p: { user: `0x${string}`; stock: ReserveAsset; quote: BuyQuote; cash: Cash }) =>
    tx.run(
      p.user,
      async () => {
        const quote = await quoteToSign(p.stock, p.quote);
        return payFromCash(p.user, quote.amountIn, p.cash, buildBuyCalls({ ...p, quote }));
      },
      "This buy would fail right now — the price may have moved or the stock may be paused. Try again in a moment.",
      [{
        kind: "buy",
        symbol: p.stock.symbol,
        amount: Number(p.quote.amountOut) / 10 ** p.stock.decimals,
        paidUsd: Number(p.quote.amountIn) / 10 ** USDC.decimals,
      }],
    );
  return { ...tx, buy };
}

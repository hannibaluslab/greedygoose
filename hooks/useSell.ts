"use client";

import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { TxStop, useTx } from "./useTx";
import { useDebounced, useSigningQuote } from "./useBuyQuote";
import { CHAIN_ID } from "@/lib/chain";
import { SELL_BLOCKED, buildSaleCalls, saleActivity, type SellFrom, type SellPlan } from "@/lib/sell";
import { quoteSwap } from "@/lib/swap/buy";
import type { SellQuote } from "@/lib/swap/sell";
import type { ReserveAsset } from "@/lib/tokens/registry";

/** Best quote for selling `sharesRaw` of `stock` for USDC, across Leo's venues. `null` = no pool can fill it. */
export function useSellQuote(stock: ReserveAsset | undefined, sharesRaw: bigint) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const shares = useDebounced(sharesRaw);
  return useQuery({
    queryKey: ["sellQuote", stock?.address, shares.toString()],
    enabled: !!client && !!stock && shares > 0n,
    refetchInterval: 15_000,
    queryFn: (): Promise<SellQuote | null> => quoteSwap(client!, stock!, shares, "sell"),
  });
}

export type SellInput = {
  user: `0x${string}`;
  stock: ReserveAsset;
  /** The quote the screen shows. */
  quote: SellQuote;
  /** planSell for that quote. */
  plan: SellPlan;
  /** Aave's price for the stock, for the swap's floor (the holding's priceUsd). */
  oraclePriceUsd: number;
  /** What the account owes, for a repay by selling (the position's debtRaw). */
  debtRaw: bigint;
};

const FALLBACK: Record<SellFrom, string> = {
  free: "This sale would fail right now — the price may have moved or the stock may be paused. Try again in a moment.",
  backing: "This sale would fail right now — the price or Aave’s limits may have moved. Try a smaller amount in a moment.",
  repay: "This repay would fail right now — the price or Aave’s limits may have moved. Try a smaller amount in a moment.",
};

/**
 * Sell stock in one batch (plan item 7 steps 2, 3 and 9): free shares, a backing holding, or a backing
 * holding sold to repay. The screen's block still holds, and the quote is read again right before JAW's sheet.
 */
export function useSell() {
  const tx = useTx("The sale didn’t go through on Base. Nothing moved except any network fee.");
  const quoteToSign = useSigningQuote();
  const sell = (p: SellInput) =>
    tx.run(
      p.user,
      async () => {
        if (p.plan.block) throw new TxStop(SELL_BLOCKED[p.plan.block]);
        const quote = await quoteToSign(p.stock, p.quote, "sell");
        return buildSaleCalls({ ...p, from: p.plan.from, quote });
      },
      FALLBACK[p.plan.from],
      saleActivity(p.stock, p.plan),
    );
  return { ...tx, sell };
}

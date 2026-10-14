"use client";

import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TxStop } from "./useTx";
import { CHAIN_ID } from "@/lib/chain";
import { QUOTE_MOVED, quoteBuy, quotePool, signingQuote, type BuyQuote } from "@/lib/swap/buy";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

export function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Best quote across Aerodrome tick spacings and Uniswap v3 fee tiers. `null` = no pool can fill it. */
export function useBuyQuote(stock: ReserveAsset | undefined, amountUsd: number) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const amount = useDebounced(amountUsd);
  return useQuery({
    queryKey: ["buyQuote", stock?.address, amount],
    enabled: !!client && !!stock && amount > 0,
    refetchInterval: 15_000,
    queryFn: (): Promise<BuyQuote | null> => quoteBuy(client!, stock!, parseUnits(amount.toFixed(USDC.decimals), USDC.decimals)),
  });
}

/**
 * The quote to sign with, read again right before Face ID (plan item 3): useBuyQuote only refreshes
 * every 15 s. When the price fell under the review's floor, it refreshes the screen's quote and stops
 * the batch with QUOTE_MOVED, so the review shows the new amount.
 */
export function useSigningQuote() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  return async (stock: ReserveAsset, shown: BuyQuote): Promise<BuyQuote> => {
    const fresh = await quotePool(client!, stock, shown.venue, shown.pool, shown.amountIn).catch(() => null);
    const quote = fresh && signingQuote(shown, fresh);
    if (quote) return quote;
    void queryClient.invalidateQueries({ queryKey: ["buyQuote", stock.address] });
    throw new TxStop(QUOTE_MOVED);
  };
}

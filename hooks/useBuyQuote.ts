"use client";

import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TxStop } from "./useTx";
import { CHAIN_ID } from "@/lib/chain";
import { QUOTE_MOVED, quoteBuy, quotePool, signingQuote, type BuyQuote, type Side } from "@/lib/swap/buy";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

export function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Best quote across Aerodrome tick spacings and Uniswap v3 fee tiers, for dollars as typed (debounced). `null` = no pool can fill it. */
export function useBuyQuote(stock: ReserveAsset | undefined, amountUsd: number) {
  const amount = useDebounced(amountUsd);
  return useBuyQuoteRaw(stock, amount > 0 ? parseUnits(amount.toFixed(USDC.decimals), USDC.decimals) : 0n);
}

/**
 * useBuyQuote for an exact USDC amount in raw units, not debounced: the Trade sheet's stock → stock buy, which spends
 * the sale's floor once the sale's own (debounced) quote is in. Same "buyQuote" key, so useSigningQuote refreshes it.
 */
export function useBuyQuoteRaw(stock: ReserveAsset | undefined, amountInRaw: bigint) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["buyQuote", stock?.address, amountInRaw.toString()],
    enabled: !!client && !!stock && amountInRaw > 0n,
    refetchInterval: 15_000,
    queryFn: (): Promise<BuyQuote | null> => quoteBuy(client!, stock!, amountInRaw),
  });
}

/**
 * The quote to sign with, read again while the batch is prepared (plan item 3; at most 30 s before the tap,
 * lib/tx/prepared.ts): useBuyQuote and useSellQuote only refresh every 15 s. When the price fell under the screen's
 * floor, it refreshes the screen's quote and stops the batch with QUOTE_MOVED, so the screen shows the new amount.
 */
export function useSigningQuote() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  return async (stock: ReserveAsset, shown: BuyQuote, side: Side = "buy"): Promise<BuyQuote> => {
    const fresh = await quotePool(client!, stock, shown.venue, shown.pool, shown.amountIn, side).catch(() => null);
    const quote = fresh && signingQuote(shown, fresh);
    if (quote) return quote;
    void queryClient.invalidateQueries({ queryKey: [side === "buy" ? "buyQuote" : "sellQuote", stock.address] });
    throw new TxStop(QUOTE_MOVED);
  };
}

"use client";

import { usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { TxStop } from "./useTx";
import { CHAIN_ID } from "@/lib/chain";
import { cashShort, readCash, type Cash } from "@/lib/cash";

/**
 * The cash to sign with, read again right before Face ID, as useSigningQuote reads the quote: usePosition only
 * refreshes every 15 s, and cash can move between the review and the tap. When `amountRaw` and the network fee no
 * longer fit, it refreshes the screen's balances and stops the batch with cashShort's words, so the review shows
 * what's there now.
 */
export function useSigningCash() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  return async (user: `0x${string}`, amountRaw: bigint): Promise<Cash> => {
    const cash = await readCash(client!, user);
    const short = cashShort(amountRaw, cash);
    if (!short) return cash;
    void queryClient.invalidateQueries({ queryKey: ["readContracts"] });
    throw new TxStop(short);
  };
}

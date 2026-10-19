"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { ALCHEMY_ON, transfersIn } from "@/lib/activity/alchemy";
import { arrivalTxs } from "@/lib/activity/arrivals";

/**
 * The transactions that brought `account` a cent or more of USDC, or a stock, since the app's first block, newest
 * first (Alchemy's Transfers API): one read, shared by Activity and the Cash sheet. Off without NEXT_PUBLIC_ALCHEMY_KEY
 * or an account.
 */
export function useTransfersIn(account: Address | undefined) {
  return useQuery({
    queryKey: ["transfersIn", account],
    enabled: ALCHEMY_ON && !!account,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: async () => arrivalTxs(await transfersIn(account!)),
  });
}

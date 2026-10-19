"use client";

import { useReadContracts } from "wagmi";
import { cashBalanceReads } from "@/lib/cashSetup";

/** The other dollars in the account's wallet that Turn into cash takes (CASH_COINS, D20): raw units in that order. */
export function useCashCoinBalances(account: `0x${string}`) {
  const q = useReadContracts({
    contracts: cashBalanceReads(account),
    allowFailure: false,
    query: { refetchInterval: 20_000 },
  });
  return q.data as readonly bigint[] | undefined;
}

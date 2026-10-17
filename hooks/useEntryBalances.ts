"use client";

import { erc20Abi } from "viem";
import { useReadContracts } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/** The other dollars in the account's wallet that become cash (ENTRY_COINS, D20): raw units in that order, once read. */
export function useEntryBalances(account: `0x${string}`) {
  const q = useReadContracts({
    contracts: ENTRY_COINS.map(
      (c) =>
        ({ address: c.address, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: CHAIN_ID }) as const,
    ),
    allowFailure: false,
    query: { refetchInterval: 20_000 },
  });
  return q.data as readonly bigint[] | undefined;
}

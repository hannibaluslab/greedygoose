"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_GUARD } from "@/lib/agents/config";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { DEFAULT_PROTECT, type ProtectNumbers } from "@/lib/agents/lines";

/** Protect's own line and target now (GooseGuard's `linesOf`, decision 3), alone; the defaults until read. */
export function useProtectNumbers(account: `0x${string}`): ProtectNumbers {
  const { data } = useReadContract({
    address: GOOSE_GUARD ?? zeroAddress,
    abi: guardAbi,
    functionName: "linesOf",
    args: [account],
    chainId: CHAIN_ID,
    query: { enabled: !!GOOSE_GUARD, refetchInterval: 60_000 },
  });
  return useMemo(
    () => (data ? { line: Number(data[0]) / 1e18, target: Number(data[1]) / 1e18 } : DEFAULT_PROTECT),
    [data],
  );
}

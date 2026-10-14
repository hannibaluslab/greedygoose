"use client";

import { useReadContract } from "wagmi";
import { GUARDIAN } from "@/lib/guardian/config";
import { USDC } from "@/lib/tokens/registry";
import { aprToApy } from "@/lib/aave/math";
import { v3ReserveAbi } from "@/hooks/usePosition";

/**
 * The cash rate before sign-in: Aave V3's USDC supply rate on Base, the same read `usePosition` makes for
 * `savingsApr`, but public, so it needs no account. Returns the yearly yield (APY, a fraction), undefined until read.
 */
export function useCashRate() {
  const q = useReadContract({
    address: GUARDIAN.AAVE_V3_POOL,
    abi: v3ReserveAbi,
    functionName: "getReserveData",
    args: [USDC.address],
    query: { refetchInterval: 60_000 },
  });
  return q.data ? aprToApy(Number(q.data.currentLiquidityRate) / 1e27) : undefined;
}

"use client";

import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { CHAIN_ID } from "@/lib/chain";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { aeroQuoterAbi, quoterV2Abi } from "@/lib/swap/abis";
import { bestQuote, type BuyQuote } from "@/lib/swap/buy";
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
    queryFn: async (): Promise<BuyQuote | null> => {
      const amountIn = parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
      const aero = AERODROME.TICK_SPACINGS.map(async (pool): Promise<BuyQuote> => {
        const { result } = await client!.simulateContract({
          address: AERODROME.QUOTER,
          abi: aeroQuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: USDC.address, tokenOut: stock!.address, amountIn, tickSpacing: pool, sqrtPriceLimitX96: 0n }],
        });
        return { venue: "aerodrome", pool, amountIn, amountOut: result[0] };
      });
      const uni = UNISWAP.FEE_TIERS.map(async (pool): Promise<BuyQuote> => {
        const { result } = await client!.simulateContract({
          address: UNISWAP.QUOTER_V2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: USDC.address, tokenOut: stock!.address, amountIn, fee: pool, sqrtPriceLimitX96: 0n }],
        });
        return { venue: "uniswap", pool, amountIn, amountOut: result[0] };
      });
      const settled = await Promise.allSettled([...aero, ...uni]);
      return bestQuote(settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
    },
  });
}

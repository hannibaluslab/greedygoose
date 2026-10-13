"use client";

import { useAccount, useCapabilities } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { usdcFeeSupport } from "@/lib/jaw/capabilities";
import type { ChainCapabilities } from "@jaw.id/core";

/** Decision D4: network fees are paid in USDC; block writes if JAW can't take USDC on Base. */
export function useFeeSupport() {
  const { address } = useAccount();
  const caps = useCapabilities({ account: address, query: { enabled: !!address } });
  const chainCaps = (caps.data as Record<number, ChainCapabilities> | undefined)?.[CHAIN_ID];
  if (!address) return { state: "unknown" as const, loading: false };
  if (caps.isLoading) return { state: "unknown" as const, loading: true };
  return { state: usdcFeeSupport(chainCaps), loading: false };
}

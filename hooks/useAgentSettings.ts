"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { rebalanceOptions, unpackMix } from "@/lib/agents/mix";

/**
 * The agents' settings in GooseExecutor's registry, read from the chain so they survive cleared browser storage: the
 * Rebalancer's mix (`mixes`), Protect · sell's "Keep my mix" (`accounts`), and the Rebalancer's live numbers
 * (`rebalanceLimits`, D18). Null until the executor is configured and read.
 */
export function useAgentSettings(account: `0x${string}`) {
  const executor = GOOSE_EXECUTOR;
  const at = executor ?? zeroAddress; // the reads stay off until the executor is configured
  const q = useReadContracts({
    contracts: [
      { address: at, abi: gooseExecutorAbi, functionName: "mixes", args: [account], chainId: CHAIN_ID },
      { address: at, abi: gooseExecutorAbi, functionName: "accounts", args: [account], chainId: CHAIN_ID },
      { address: at, abi: gooseExecutorAbi, functionName: "rebalanceLimits", chainId: CHAIN_ID },
    ],
    allowFailure: false,
    query: { enabled: !!executor, refetchInterval: 20_000 },
  });

  return useMemo(() => {
    if (!q.data) return null;
    const [mix, a, [bandBps, bandMaxBps, , floorBps, minTrade, maxSlice]] = q.data;
    return {
      /** BPS per stock by reserve id; all 0 before a mix is saved. */
      mixBps: unpackMix(mix),
      keepMix: a[7],
      options: rebalanceOptions({ bandBps, bandMaxBps, floorBps, minTrade, maxSlice }),
    };
  }, [q.data]);
}

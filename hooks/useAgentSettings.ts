"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { executorAccountsAbi } from "@/lib/agents/abis/accounts";
import { rebalanceOptions, unpackMix } from "@/lib/agents/mix";
import type { Plan, RuleNumbers } from "@/lib/agents/next";

const WAD = 1e18;

/**
 * The agents' settings and numbers in GooseExecutor's registry, read from the chain so they survive cleared browser
 * storage: the Rebalancer's mix (`mixes`); the account's slot (`accounts`: Protect · sell's "Keep my mix", the rescue
 * under way, the Rebalancer's last day); the live numbers Protect's and the Rebalancer's rules run with (D18); and what
 * a run would do now (`planOf`). Null until the executor is configured and read.
 */
export function useAgentSettings(account: `0x${string}`) {
  const executor = GOOSE_EXECUTOR;
  const at = executor ?? zeroAddress; // the reads stay off until the executor is configured
  const read = { address: at, abi: gooseExecutorAbi, chainId: CHAIN_ID } as const;
  const q = useReadContracts({
    contracts: [
      { ...read, functionName: "mixes", args: [account] },
      // The fields every deployed executor has (the one live today has no protectIndex).
      { address: at, abi: executorAccountsAbi, functionName: "accounts", args: [account], chainId: CHAIN_ID },
      { ...read, functionName: "rebalanceLimits" },
      { ...read, functionName: "amounts" },
      { ...read, functionName: "thresholds" },
    ],
    allowFailure: false,
    query: { enabled: !!executor, refetchInterval: 20_000 },
  });
  // Apart from the rest: a view that plans every job could run out of gas or revert, and the others don't wait on it.
  const plan = useReadContract({
    ...read,
    functionName: "planOf",
    args: [account],
    query: { enabled: !!executor, refetchInterval: 20_000 },
  });

  return useMemo(() => {
    if (!q.data) return null;
    const [mix, a, [bandBps, bandMaxBps, , floorBps, minTrade, maxSlice], [minRepay, , , weekendWindow], thresholds] =
      q.data;
    const [triggerHf, targetHf, stressDrop, stressFloorHf] = thresholds;
    const options = rebalanceOptions({ bandBps, bandMaxBps, floorBps, minTrade, maxSlice });
    const numbers: RuleNumbers = {
      minRepayRaw: minRepay,
      triggerHf: Number(triggerHf) / WAD,
      targetHf: Number(targetHf) / WAD,
      stressDrop: Number(stressDrop) / WAD,
      stressFloorHf: Number(stressFloorHf) / WAD,
      weekendWindowSec: weekendWindow,
      rebalance: options,
    };
    return {
      /** BPS per stock by reserve id; all 0 before a mix is saved. */
      mixBps: unpackMix(mix),
      keepMix: a[7],
      /** A rescue Protect started is under way (`rescueAt`, when it started, isn't 0): it goes on until the target. */
      rescuing: a[6] !== 0,
      /** The New York day the Rebalancer last traded. */
      rebalanceDay: a[8],
      options,
      numbers,
      plan: (plan.data ?? null) as Plan | null,
    };
  }, [q.data, plan.data]);
}

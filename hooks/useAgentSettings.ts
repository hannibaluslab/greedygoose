"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { rebalanceOptions, unpackMix } from "@/lib/agents/mix";
import { nyDay, type Plan, type RuleNumbers } from "@/lib/agents/next";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { useNowSec } from "@/hooks/useNowSec";

const WAD = 1e18;

/**
 * The agents' settings and numbers in GooseExecutor's registry, read from the chain so they survive cleared browser
 * storage: the Rebalancer's mix (`mixes`); the account's slot (`accounts`: Protect · sell's "Keep my mix" and pending
 * heads-up, today's saves, the Rebalancer's last day); the coins Receive is waiting on (`entryWaits`); the live numbers
 * every rule runs with (D18); and what a run would do now (`planOf`). Null until the executor is configured and read.
 */
export function useAgentSettings(account: `0x${string}`) {
  const executor = GOOSE_EXECUTOR;
  const at = executor ?? zeroAddress; // the reads stay off until the executor is configured
  const read = { address: at, abi: gooseExecutorAbi, chainId: CHAIN_ID } as const;
  const q = useReadContracts({
    contracts: [
      { ...read, functionName: "mixes", args: [account] },
      { ...read, functionName: "accounts", args: [account] },
      { ...read, functionName: "rebalanceLimits" },
      { ...read, functionName: "amounts" },
      { ...read, functionName: "thresholds" },
      { ...read, functionName: "sellLimits" },
      { ...read, functionName: "entryLimits" },
      { ...read, functionName: "entryWaits", args: [account] },
    ],
    allowFailure: false,
    query: { enabled: !!executor, refetchInterval: 20_000 },
  });
  // Apart from the rest: a view that plans every job could run out of gas or revert, and the others don't wait on it.
  const plan = useReadContract({ ...read, functionName: "planOf", args: [account], query: { enabled: !!executor, refetchInterval: 20_000 } });
  const nowSec = useNowSec();

  return useMemo(() => {
    if (!q.data) return null;
    const [mix, a, [bandBps, bandMaxBps, , floorBps, minTrade, maxSlice], amounts, thresholds, sell, entry, waits] = q.data;
    const [minRepay, minSave, keepBack, , maxSavesPerDay] = amounts;
    const [triggerHf, targetHf, stressDrop, stressFloorHf] = thresholds;
    const options = rebalanceOptions({ bandBps, bandMaxBps, floorBps, minTrade, maxSlice });
    const numbers: RuleNumbers = {
      keepBackRaw: keepBack,
      minSaveRaw: minSave,
      maxSavesPerDay,
      minRepayRaw: minRepay,
      triggerHf: Number(triggerHf) / WAD,
      targetHf: Number(targetHf) / WAD,
      stressDrop: Number(stressDrop) / WAD,
      stressFloorHf: Number(stressFloorHf) / WAD,
      rebalance: options,
      entry: { floorBps: BigInt(entry[0]), minEntryRaw: entry[1], maxSwapRaw: entry[2] },
    };
    return {
      /** BPS per stock by reserve id; all 0 before a mix is saved. */
      mixBps: unpackMix(mix),
      keepMix: a[7],
      /** When Protect · sell's pending heads-up went out, in seconds; 0 when none is pending. */
      headsUpAt: a[6],
      /** Saves made today (New York), and the New York day the Rebalancer last traded. */
      savesToday: a[4] === nyDay(nowSec) ? a[5] : 0,
      rebalanceDay: a[8],
      /** When each Entry coin may be tried again, in ENTRY_COINS order (seconds; 0 = not waiting). */
      entryRetryAt: ENTRY_COINS.map((_, k) => Number((waits >> BigInt(32 * k)) & 0xffffffffn)),
      /** Protect · sell's target: the health a sale brings the credit back to (WAD). */
      sellTargetHf: Number(sell[2]) / WAD,
      options,
      numbers,
      plan: (plan.data ?? null) as Plan | null,
    };
  }, [q.data, plan.data, nowSec]);
}

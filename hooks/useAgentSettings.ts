"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useNowSec } from "@/hooks/useNowSec";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_GUARD, GOOSE_PLANNER } from "@/lib/agents/config";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { plannerAbi } from "@/lib/agents/abis/GoosePlanner";
import { rebalanceOptions, unpackMix } from "@/lib/agents/mix";
import { defaultNumbers, type Plan, type RuleNumbers } from "@/lib/agents/next";

const WAD = 1e18;
/** GooseGuard's RESCUE_MAX_AGE: an unfinished rescue ends after 7 days (decision 5's backstop). */
const RESCUE_MAX_AGE_SEC = 7 * 86_400;

/**
 * The agents' settings and numbers, read from the chain so they survive cleared browser storage. From GooseGuard
 * (`accountOf`): the Rebalancer's mix, Protect · sell's "Keep my mix", the rescue under way, the Rebalancer's pacing and
 * top-ups; and `linesOf`, the account's own Protect line and target (1.03 and 1.12 unless it set others). From the
 * Planner: the numbers the Rebalancer's and the weekend card's rules run with (D18) and what a round would do now
 * (`planOf`); the defaults (config/risk.ts) until it is read. Null until the Guard is configured and read.
 */
export function useAgentSettings(account: `0x${string}`) {
  const guard = GOOSE_GUARD;
  const planner = GOOSE_PLANNER;
  const atGuard = guard ?? zeroAddress; // the reads stay off until each is configured
  const atPlanner = planner ?? zeroAddress;
  const own = useReadContracts({
    contracts: [
      { address: atGuard, abi: guardAbi, functionName: "accountOf", args: [account], chainId: CHAIN_ID },
      { address: atGuard, abi: guardAbi, functionName: "linesOf", args: [account], chainId: CHAIN_ID },
    ],
    allowFailure: false,
    query: { enabled: !!guard, refetchInterval: 20_000 },
  });
  const read = { address: atPlanner, abi: plannerAbi, chainId: CHAIN_ID } as const;
  const views = useReadContracts({
    contracts: [
      { ...read, functionName: "rebalanceLimits" },
      { ...read, functionName: "amounts" },
      { ...read, functionName: "thresholds" },
    ],
    allowFailure: false,
    query: { enabled: !!planner, refetchInterval: 60_000 },
  });
  // Apart from the rest: a view that plans every job could run out of gas or revert, and the others don't wait on it.
  const plan = useReadContract({
    ...read,
    functionName: "planOf",
    args: [account],
    query: { enabled: !!planner, refetchInterval: 20_000 },
  });
  // A rescue's age is checked to the minute: the second only moves the clock.
  const minute = Math.floor(useNowSec() / 60);

  return useMemo(() => {
    if (!own.data) return null;
    const [[a, s], [lineWad, targetWad]] = own.data;
    const fallback = defaultNumbers(rebalanceOptions());
    let numbers: RuleNumbers = fallback;
    if (views.data) {
      const [[bandBps, bandMaxBps, , floorBps, minTrade, maxSlice], [minRepay, , , weekendWindow], thresholds] =
        views.data;
      const [, , stressDrop, stressFloorHf] = thresholds;
      numbers = {
        minRepayRaw: minRepay,
        triggerHf: fallback.triggerHf,
        targetHf: fallback.targetHf,
        stressDrop: Number(stressDrop) / WAD,
        stressFloorHf: Number(stressFloorHf) / WAD,
        weekendWindowSec: weekendWindow,
        rebalance: rebalanceOptions({ bandBps, bandMaxBps, floorBps, minTrade, maxSlice }),
      };
    }
    // Protect's line and target are the account's own (decision 3), whatever the Planner's defaults say.
    numbers = { ...numbers, triggerHf: Number(lineWad) / WAD, targetHf: Number(targetWad) / WAD };
    return {
      /** BPS per stock by reserve id; all 0 before a mix is saved. */
      mixBps: unpackMix(s.mix),
      keepMix: s.keepMix,
      /**
       * A rescue Protect started is under way (`rescueAt`, when it started, isn't 0, and it is under 7 days old): it goes
       * on until the target, or until the user takes credit or repays by hand (`endRescue`).
       */
      rescuing: a.rescueAt !== 0 && minute * 60 <= a.rescueAt + RESCUE_MAX_AGE_SEC,
      /** The Rebalancer's pacing: when its last session opened, and when the mix was last set. */
      pacing: { sessionAt: a.sessionAt, mixSetAt: s.mixSetAt },
      /** Top-ups go into my mix: the switch and Keep as cash (USDC units). */
      topUps: { on: s.topUpsOn, keepRaw: BigInt(s.keep) },
      options: numbers.rebalance,
      numbers,
      plan: (plan.data ?? null) as Plan | null,
    };
  }, [own.data, views.data, plan.data, minute]);
}

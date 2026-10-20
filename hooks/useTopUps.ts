"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition } from "@/hooks/usePosition";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { readTopUps, type TopUpsAnswer, type TopUpsRead } from "@/lib/agents/topUps";

/** What an executor that doesn't count top-ups (or no executor at all) reads as. */
const NONE: TopUpsAnswer = { status: "failure" };

/**
 * GooseExecutor's `topUps(account)`, allowed to fail: the executor live today has no such getter, so its revert reads
 * as "not available" and every screen keeps working on it. Without an executor, not available either. Undefined
 * while it loads or Base can't be read.
 */
function useTopUpsAnswer(account: `0x${string}`): { answer: TopUpsAnswer | undefined; loading: boolean } {
  const executor = GOOSE_EXECUTOR;
  const q = useReadContracts({
    contracts: [
      {
        address: executor ?? zeroAddress,
        abi: gooseExecutorAbi,
        functionName: "topUps",
        args: [account],
        chainId: CHAIN_ID,
      },
    ],
    allowFailure: true,
    query: { enabled: !!executor, refetchInterval: 20_000 },
  });
  if (!executor) return { answer: NONE, loading: false };
  return { answer: q.data?.[0] as TopUpsAnswer | undefined, loading: q.isPending };
}

/**
 * The account's own top-ups switch and Keep as cash (USDC units) as the executor has them, for a turn-off's batch:
 * undefined while it's first read, null on an executor that doesn't count top-ups or when Base can't be read.
 */
export function useTopUpsSwitch(account: `0x${string}`): { on: boolean; keepRaw: bigint } | null | undefined {
  const { answer, loading } = useTopUpsAnswer(account);
  if (loading) return undefined;
  if (answer?.status !== "success") return null;
  const [on, , keep] = answer.result;
  return { on, keepRaw: BigInt(keep) };
}

/**
 * Top-ups as Rebalance's sheet shows them (lib/agents/topUps.ts `readTopUps`): whether the executor counts them, the
 * switch and Keep, and what waits to go into the mix and when, with the savings and Rebalance's last day read now.
 * Null until the reads are in.
 */
export function useTopUps(account: `0x${string}`): TopUpsRead | null {
  const { answer } = useTopUpsAnswer(account);
  const { data: position } = usePosition(account);
  const settings = useAgentSettings(account);
  const nowSec = useNowSec();
  // Once a minute is enough for "waiting" and its day: the second only moves the clock.
  const minute = Math.floor(nowSec / 60);
  const savingsRaw = position?.savingsRaw;
  const rebalanceDay = settings?.rebalanceDay;
  return useMemo(() => {
    if (!answer || savingsRaw === undefined || minute === 0) return null;
    // A revert needs neither: nothing counts.
    if (answer.status === "success" && rebalanceDay === undefined) return null;
    return readTopUps(answer, { nowSec: minute * 60, savingsRaw, rebalanceDay: rebalanceDay ?? 0 });
  }, [answer, savingsRaw, rebalanceDay, minute]);
}

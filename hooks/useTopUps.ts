"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract } from "wagmi";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition } from "@/hooks/usePosition";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import type { TopUpsState } from "@/lib/agents/rules/topUps";
import {
  readTopUps,
  topUpsAnswerOf,
  topUpsReverted,
  topUpsStateOf,
  type TopUpsAnswer,
  type TopUpsRead,
} from "@/lib/agents/topUps";

/** What an executor that doesn't count top-ups (or no executor at all) reads as. */
const NONE: TopUpsAnswer = { status: "failure" };

/**
 * GooseExecutor's `topUps(account)`. The executor live today has no such getter: its revert reads as "not available"
 * and every screen keeps working on it (a revert is the answer, so it isn't tried again). Without an executor, not
 * available either. Undefined until Base answers: Base not answering (a 429, a dropped call) is never read as a revert
 * (`topUpsAnswerOf`), and a refetch that fails keeps the last answer.
 */
function useTopUpsAnswer(account: `0x${string}`): TopUpsAnswer | undefined {
  const executor = GOOSE_EXECUTOR;
  const q = useReadContract({
    address: executor ?? zeroAddress,
    abi: gooseExecutorAbi,
    functionName: "topUps",
    args: [account],
    chainId: CHAIN_ID,
    query: { enabled: !!executor, refetchInterval: 20_000, retry: (n, e) => n < 3 && !topUpsReverted(e) },
  });
  const answer = useMemo(() => topUpsAnswerOf(q.data, q.error), [q.data, q.error]);
  return executor ? answer : NONE;
}

/**
 * The account's own top-ups switch and Keep as cash (USDC units) as the executor has them, for a turn-off's batch:
 * undefined until Base answers (a turn-off waits rather than leave top-ups on), null on an executor that doesn't count
 * top-ups.
 */
export function useTopUpsSwitch(account: `0x${string}`): { on: boolean; keepRaw: bigint } | null | undefined {
  const answer = useTopUpsAnswer(account);
  if (!answer) return undefined;
  if (answer.status !== "success") return null;
  const [on, , keep] = answer.result;
  return { on, keepRaw: BigInt(keep) };
}

/**
 * The executor's top-up counts for the account while its switch is on (`topUpsStateOf`), for Rebalance's card to work
 * out what goes in at the next check; null while off, unread, or on an executor that doesn't count top-ups.
 */
export function useTopUpsState(account: `0x${string}`): TopUpsState | null {
  const answer = useTopUpsAnswer(account);
  return useMemo(() => (answer ? topUpsStateOf(answer) : null), [answer]);
}

/**
 * Top-ups as Rebalance's sheet shows them (lib/agents/topUps.ts `readTopUps`): whether the executor counts them, the
 * switch and Keep, and what waits to go into the mix and when, with the savings and Rebalance's last day read now.
 * Null until the reads are in.
 */
export function useTopUps(account: `0x${string}`): TopUpsRead | null {
  const answer = useTopUpsAnswer(account);
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

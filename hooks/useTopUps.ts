"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_GUARD, GOOSE_PLANNER } from "@/lib/agents/config";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { plannerAbi } from "@/lib/agents/abis/GoosePlanner";
import type { TopUpsRead } from "@/lib/agents/topUps";

/**
 * The account's top-ups switch and Keep as GooseGuard has them (`accountOf`'s settings). Undefined until Base answers;
 * a refetch that fails keeps the last answer.
 */
function useTopUpsSetting(account: `0x${string}`) {
  const guard = GOOSE_GUARD;
  const q = useReadContract({
    address: guard ?? zeroAddress,
    abi: guardAbi,
    functionName: "accountOf",
    args: [account],
    chainId: CHAIN_ID,
    query: { enabled: !!guard, refetchInterval: 20_000 },
  });
  const setting = useMemo(
    () => (q.data ? { on: q.data[1].topUpsOn, keepRaw: BigInt(q.data[1].keep) } : undefined),
    [q.data],
  );
  // Base didn't answer after its retries and nothing was read before: not loading any more.
  return { guard, setting, unreadable: !setting && q.isError && q.fetchStatus === "idle" };
}

/**
 * The account's own top-ups switch and Keep as cash (USDC units) as the Guard has them, for a turn-off's batch:
 * undefined while Base is still answering (a turn-off waits rather than leave top-ups on), "unreadable" when Base
 * didn't answer (a turn-off then says why at the button), null with no Guard configured.
 */
export function useTopUpsSwitch(
  account: `0x${string}`,
): { on: boolean; keepRaw: bigint } | null | undefined | "unreadable" {
  const { guard, setting, unreadable } = useTopUpsSetting(account);
  if (!guard) return null;
  if (!setting) return unreadable ? "unreadable" : undefined;
  return setting;
}

/**
 * What the Rebalancer would put into the mix at the next round, USDC units: the Planner's `topUpsReady` (the wallet
 * rule, live), while the switch is on. Null while it's off, unread, or no Planner is configured.
 */
export function useTopUpsReady(account: `0x${string}`): bigint | null {
  const { setting } = useTopUpsSetting(account);
  const planner = GOOSE_PLANNER;
  const on = !!setting?.on;
  const q = useReadContract({
    address: planner ?? zeroAddress,
    abi: plannerAbi,
    functionName: "topUpsReady",
    args: [account],
    chainId: CHAIN_ID,
    query: { enabled: !!planner && on, refetchInterval: 20_000 },
  });
  return on && q.data !== undefined ? q.data : null;
}

/**
 * Top-ups as Rebalance's sheet shows them (lib/agents/topUps.ts `chainFacts`): whether a Guard is configured, the
 * switch and Keep, and what waits to go into the mix at the next round. Null until the switch is read.
 */
export function useTopUps(account: `0x${string}`): TopUpsRead | null {
  const { guard, setting } = useTopUpsSetting(account);
  const ready = useTopUpsReady(account);
  return useMemo(() => {
    if (!guard) return { available: false, on: false, keepRaw: 0n, waitingRaw: 0n };
    if (!setting) return null;
    return { available: true, on: setting.on, keepRaw: setting.keepRaw, waitingRaw: ready ?? 0n };
  }, [guard, setting, ready]);
}

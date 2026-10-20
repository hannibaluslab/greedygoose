"use client";

import { maxUint160 } from "viem";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition } from "@/hooks/usePosition";
import { AGENTS_LIVE, GOOSE_EXECUTOR } from "@/lib/agents/config";
import { agentStatus } from "@/lib/agents/list";
import { rebalanceOptions } from "@/lib/agents/mix";
import { defaultNumbers, rebalanceOutlook } from "@/lib/agents/next";
import { startCapRaw } from "@/lib/agents/permissions";
import { rebalanceCard, type RebalanceCardModel } from "@/lib/agents/rebalanceCard";

/**
 * Rebalance's state as its overview card draws it (lib/agents/rebalanceCard.ts), from the account's reads: the
 * registry, JAW's list, the position and the agents' feed. The card and the sheet's pill and line both take it from
 * here, so the two never disagree. Null while the reads are in or the Rebalancer's state loads.
 */
export function useRebalanceCard(account: `0x${string}`): RebalanceCardModel | null {
  const agents = useAgents(account);
  const settings = useAgentSettings(account);
  const { data: position } = usePosition(account);
  const feed = useAgentFeed(account);
  const nowSec = useNowSec();
  // The registry's mix and numbers are read once an executor is set; until then it runs on the deploy defaults.
  if (!position || nowSec === 0 || (!settings && GOOSE_EXECUTOR)) return null;

  const capMax = agents.capMaxRaw;
  const numbers = settings?.numbers ?? defaultNumbers(rebalanceOptions());
  const mixBps = settings?.mixBps ?? null;
  const rebalanceDay = settings?.rebalanceDay ?? 0;
  const outlook = rebalanceOutlook({
    nowSec,
    holdings: position.holdings,
    mixBps,
    capMaxRaw: capMax,
    rebalanceDay,
    debtUsd: position.debtUsd,
    totalBackingUsd: position.totalBackingUsd,
    avgCf: position.avgCf,
    left: { rebalance: agents.left.rebalance },
    // The grant it runs with, else the one it starts on: the executor's CAP_MAX (no amount limit).
    capRaw: { rebalance: agents.terms.rebalance?.capRaw ?? startCapRaw("rebalance", capMax ?? maxUint160) },
    numbers,
  });
  // Off without the user turning it off: its grant ran out, or the executor switched it off.
  const last = feed.switched.rebalance;
  const stopped =
    agents.status.rebalance !== "off" || last?.byUser
      ? 0
      : Math.max(agents.ranOut.rebalance ?? 0, last && !last.on ? last.at : 0);
  return rebalanceCard({
    live: AGENTS_LIVE,
    nowSec,
    status: agentStatus("rebalance", agents.status),
    waiting: agents.toFinish.includes("rebalance"),
    stoppedAt: stopped > 0 ? stopped : null,
    endsAt: agents.terms.rebalance?.end ?? null,
    fails: agents.fails,
    cooldownUntil: agents.cooldownUntil,
    rebalanceDay,
    holdings: position.holdings,
    mixBps,
    options: numbers.rebalance,
    outlook,
  });
}

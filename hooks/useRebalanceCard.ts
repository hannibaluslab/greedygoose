"use client";

import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition } from "@/hooks/usePosition";
import { useTopUpsReady } from "@/hooks/useTopUps";
import { AGENTS_LIVE, GOOSE_GUARD } from "@/lib/agents/config";
import { refusedInARow } from "@/lib/agents/feed";
import { agentStatus } from "@/lib/agents/list";
import { rebalanceOptions } from "@/lib/agents/mix";
import { defaultNumbers, rebalanceOutlook } from "@/lib/agents/next";
import { rebalanceCard, type RebalanceCardModel } from "@/lib/agents/rebalanceCard";

/**
 * Rebalance's state as its overview card draws it (lib/agents/rebalanceCard.ts), from the account's reads: GooseGuard,
 * JAW's list, the position, the agents' feed and the top-ups waiting. The card and the sheet's pill and line both take
 * it from here, so the two never disagree. Null while the reads are in or the Rebalancer's state loads.
 */
export function useRebalanceCard(account: `0x${string}`): RebalanceCardModel | null {
  const agents = useAgents(account);
  const settings = useAgentSettings(account);
  const { data: position } = usePosition(account);
  const feed = useAgentFeed(account);
  const ready = useTopUpsReady(account);
  const nowSec = useNowSec();
  // The account's mix and pacing are read once a Guard is set; until then it runs on the defaults.
  if (!position || nowSec === 0 || (!settings && GOOSE_GUARD)) return null;

  const numbers = settings?.numbers ?? defaultNumbers(rebalanceOptions());
  const mixBps = settings?.mixBps ?? null;
  const outlook = rebalanceOutlook({
    nowSec,
    holdings: position.holdings,
    mixBps,
    pacing: settings?.pacing ?? { sessionAt: 0, mixSetAt: 0 },
    debtUsd: position.debtUsd,
    totalBackingUsd: position.totalBackingUsd,
    avgCf: position.avgCf,
    numbers,
  });
  // Off without the user turning it off: its grant ran out.
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
    refused: refusedInARow(feed.events).rebalance,
    holdings: position.holdings,
    mixBps,
    options: numbers.rebalance,
    outlook,
    // Top-ups while the account's switch is on: what waits in the wallet goes in at the next round (0 until read).
    topUps: settings?.topUps.on ? { readyRaw: ready ?? 0n } : null,
  });
}

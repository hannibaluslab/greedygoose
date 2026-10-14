"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { AgentsFeed, AgentsView, HeadsUpCard, type FeedError } from "@/components/gg/Agents";
import { useActivity } from "@/hooks/useActivity";
import { useAgentFeed, type HeadsUp } from "@/hooks/useAgentFeed";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition } from "@/hooks/usePosition";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { summarize } from "@/lib/aave/math";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { agentList, mixOnTarget } from "@/lib/agents/list";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";
import { toUsd } from "@/lib/cash";
import { CHAIN_ID } from "@/lib/chain";
import { formatUsdTrim } from "@/lib/formatting";
import { statusFor } from "@/lib/risk/status";

export default function AgentsPage() {
  return <RequireAccount>{(address) => <Agents address={address} />}</RequireAccount>;
}

/**
 * Design board "7 · Agents" (Agents.dc.html). Each agent's state comes from the executor's registry and JAW's list
 * (useAgents, D14) and its settings (useAgentSettings: the mix, the pending heads-up); with no executor configured,
 * every agent is "Not live yet". The activity merges the user's own moves (JAW's history) with the agents'
 * (GooseExecutor's events, read from the chain).
 */
function Agents({ address }: { address: `0x${string}` }) {
  const agents = useAgents(address);
  const settings = useAgentSettings(address);
  const { data: position } = usePosition(address);
  const feed = useAgentFeed(address);
  const yours = useActivity(address);
  const nowSec = useNowSec();

  const onTarget = useMemo(
    () =>
      settings && position
        ? mixOnTarget(
            settings.mixBps,
            position.holdings.map((h) => h.freeRaw),
            position.holdings.map((h) => h.priceRaw),
            settings.options,
          )
        : null,
    [settings, position],
  );
  const capRaw = Object.fromEntries(JOBS.map((job) => [job, agents.terms[job]?.capRaw ?? null])) as Record<AgentJob, bigint | null>;
  // The Rebalancer's pill waits for its mix, so a mix being read never shows as "No mix yet".
  const status = GOOSE_EXECUTOR && !settings ? { ...agents.status, rebalance: "loading" as const } : agents.status;
  const list = agentList({ status, capRaw, credit: position?.status ?? "none", onTarget });

  // The registry still holds the heads-up the event announced: a sale cut short, or one cleared, has moved it.
  const headsUpAt = settings?.headsUpAt ?? 0;
  const pending = feed.headsUp && headsUpAt !== 0 && feed.headsUp.sentAt === headsUpAt ? feed.headsUp : null;

  // The user's own moves cover the same days as the agents' moves read so far.
  const rows = useMemo(
    () => [...feed.rows, ...yours.rows.filter((r) => r.time >= feed.since)].sort((a, b) => b.time - a.time),
    [feed.rows, feed.since, yours.rows],
  );
  const error: FeedError = yours.isError && (feed.isError || !GOOSE_EXECUTOR) ? "all" : feed.isError ? "agents" : yours.isError ? "yours" : null;

  return (
    <AgentsView
      headsUp={pending && <PendingSale account={address} sale={pending} nowSec={nowSec} />}
      agents={list.agents}
      reason={list.reason}
      feed={
        <AgentsFeed
          rows={rows}
          nowMs={nowSec * 1000}
          loading={yours.isLoading || feed.isLoading}
          error={error}
          onRetry={() => {
            void yours.refetch();
            feed.refetch();
          }}
          more={feed.more}
          onShowEarlier={feed.showEarlier}
        />
      }
    />
  );
}

/**
 * The pending sale, in the board's words. "Add $X" is what brings the credit to where the sale would (Protect · sell's
 * target, read live), rounded up so it's enough; "$Y" is the stock the heads-up said it would sell. When its wait ends while
 * prices are held, the sale waits for them, and the heads-up's `sellAfter` is the moment they reopen: the second before
 * it is frozen. It reads only what it needs, so the warning never waits on the rest of the account.
 */
function PendingSale({ account, sale, nowSec }: { account: `0x${string}`; sale: HeadsUp; nowSec: number }) {
  const executor = { address: GOOSE_EXECUTOR ?? zeroAddress, abi: gooseExecutorAbi, chainId: CHAIN_ID } as const;
  const reads = useReadContracts({
    contracts: [
      { ...executor, functionName: "sellLimits" },
      { ...executor, functionName: "frozen", args: [BigInt(sale.sellAfter - 1)] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [account], chainId: CHAIN_ID },
    ],
    allowFailure: false,
    query: { enabled: !!GOOSE_EXECUTOR, refetchInterval: 20_000 },
  });
  if (!reads.data) return null;
  const [limits, reopens, data] = reads.data;
  const credit = summarize(data);
  const status = statusFor(credit.healthFactor);
  if (status !== "watch" && status !== "act") return null;
  const add = Math.ceil(credit.debtUsd - (credit.collateralUsd * credit.avgCf) / (Number(limits[2]) / 1e18));
  if (add <= 0) return null;
  const when = sale.sellAfter <= nowSec ? "now" : reopens ? "when prices reopen" : `in ${Math.ceil((sale.sellAfter - nowSec) / 60)} min`;
  return <HeadsUpCard add={formatUsdTrim(add)} sell={formatUsdTrim(toUsd(sale.sellValueRaw))} when={when} status={status} />;
}

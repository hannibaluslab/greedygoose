"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { FeedCard, FeedDays } from "@/components/gg/Activity";
import { AgentSheet, ReceiveCoins, type LimitView } from "@/components/gg/AgentSheet";
import { ProtectSettings } from "@/components/gg/agents/ProtectSettings";
import { RebalanceSettings } from "@/components/gg/agents/RebalanceSettings";
import { AgentRow, AgentsFeed, AgentsView, AttentionCard, MixBar, TurnOffAll, type FeedError } from "@/components/gg/Agents";
import { useActivity } from "@/hooks/useActivity";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useAgentRun, type AgentStep } from "@/hooks/useAgentRun";
import { GRANT_SECONDS, useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useEntryBalances } from "@/hooks/useEntryBalances";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { GrantStep } from "@/hooks/useManageSave";
import { useHeadsUp } from "@/hooks/useHeadsUp";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import {
  AGENT_JOBS,
  AGENT_NAME,
  AGENTS,
  agentCards,
  agentItems,
  agentParam,
  longDateText,
  limitText,
  timeText,
  type Agent,
  type AgentItem,
  type Next,
  type SheetAction,
} from "@/lib/agents/list";
import { rebalanceOptions } from "@/lib/agents/mix";
import { agentNexts, defaultNumbers } from "@/lib/agents/next";
import { JOBS, LIMIT_USD, limitRaw, stockLimitsRaw, type AgentJob } from "@/lib/agents/permissions";
import { toUsd } from "@/lib/cash";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

export default function AgentsPage() {
  return <RequireAccount>{(address) => <Agents address={address} />}</RequireAccount>;
}

const byJob = <T,>(f: (job: AgentJob) => T) => Object.fromEntries(JOBS.map((job) => [job, f(job)])) as Record<AgentJob, T>;
const LOADING = Object.fromEntries(AGENTS.map((a) => [a, { idle: "…" }])) as Record<Agent, Next>;

const PREVIEW = "Preview mode — sign in to do this.";

/**
 * The Agents tab (Adrian, 2026-10-15). Each agent's state is the executor's registry and JAW's list (useAgents, D14);
 * its next move is the executor's `planOf` or its TypeScript rule on live data (lib/agents/next.ts); the cards come
 * from the executor's events and registry. Every switch, Renew and Turn off opens JAW's own sheet straight away (its
 * Review and Face ID), once a grant or revoke: the row or the sheet already says the limit, so there is no confirm step
 * of ours. With no executor configured, everything renders with real data and nothing can be switched on ("Not live
 * yet").
 */
function Agents({ address }: { address: `0x${string}` }) {
  const { address: signer } = useAccount();
  const fee = useFeeSupport();
  const agents = useAgents(address);
  const settings = useAgentSettings(address);
  const { data: position } = usePosition(address);
  const feed = useAgentFeed(address);
  const yours = useActivity(address);
  const entryRaw = useEntryBalances(address);
  const nowSec = useNowSec();
  const headsUp = useHeadsUp(address, feed.headsUp, settings, nowSec);
  const runner = useAgentRun(agents);
  const live = !!GOOSE_EXECUTOR;

  // The sheet keeps its last agent while it slides away. A link can name one (`/agents?agent=protect`): its sheet
  // opens on arrival, as a row's tap opens it.
  const linked = agentParam(useSearchParams().get("agent"));
  const [open, setOpen] = useState<Agent | null>(linked);
  const [shown, setShown] = useState(!!linked);
  const [picked, setPicked] = useState<Partial<Record<Agent, number>>>({});

  const capMax = agents.capMaxRaw;
  const capOf = (usd: number) => limitRaw(usd, capMax ?? BigInt(usd) * 10n ** BigInt(USDC.decimals));
  const mixSet = !!settings?.mixBps.some((w) => w > 0);

  const next = position
    ? agentNexts({
        nowSec,
        walletRaw: position.cash.walletRaw,
        savingsRaw: position.savingsRaw,
        collateralUsd: position.collateralUsd,
        avgCf: position.avgCf,
        debtUsd: position.debtUsd,
        credit: position.status,
        holdings: position.holdings,
        mixBps: settings?.mixBps ?? null,
        left: agents.left,
        capRaw: byJob((job) => agents.terms[job]?.capRaw ?? capOf(LIMIT_USD[job].start)),
        capMaxRaw: capMax,
        numbers: settings?.numbers ?? defaultNumbers(rebalanceOptions()),
        savesToday: settings?.savesToday ?? 0,
        rebalanceDay: settings?.rebalanceDay ?? 0,
        entryRaw: entryRaw ?? [],
        entryRetryAt: settings?.entryRetryAt ?? [],
        plan: settings?.plan ?? null,
      })
    : LOADING;
  const items = agentItems({ status: agents.status, capRaw: byJob((job) => agents.terms[job]?.capRaw ?? null), next });

  const cards = agentCards({
    nowSec,
    headsUp,
    status: agents.status,
    ends: byJob((job) => agents.terms[job]?.end ?? null),
    // Off without the user turning it off: its grant ran out, or the executor switched it off.
    stopped: byJob((job) => {
      const last = feed.switched[job];
      if (agents.status[job] !== "off" || last?.byUser) return null;
      const at = Math.max(agents.ranOut[job] ?? 0, last && !last.on ? last.at : 0);
      return at > 0 ? at : null;
    }),
    waiting: ENTRY_COINS.flatMap((c, k) => {
      const retryAt = settings?.entryRetryAt[k] ?? 0;
      const balance = entryRaw?.[k] ?? 0n;
      return retryAt > nowSec && balance > 0n ? [{ symbol: c.symbol, amountRaw: balance / 10n ** BigInt(c.decimals - USDC.decimals), retryAt }] : [];
    }),
    fails: agents.fails,
    cooldownUntil: agents.cooldownUntil,
  });

  // The user's own moves cover the same days as the agents' moves read so far.
  const rows = useMemo(
    () => [...feed.rows, ...yours.rows.filter((r) => r.time >= feed.since)].sort((a, b) => b.time - a.time),
    [feed.rows, feed.since, yours.rows],
  );
  const error: FeedError = yours.isError && (feed.isError || !live) ? "all" : feed.isError ? "agents" : yours.isError ? "yours" : null;

  /** The limit an agent will run with: the one picked on its sheet, else its grant's, else the one it starts on. */
  const limitUsd = (agent: Agent) => picked[agent] ?? items.find((i) => i.agent === agent)!.limitUsd;

  /** A job's grant at `capRaw`; a job that sells stock takes a limit per stock it may sell, at Aave's price now. */
  const grantFor = (job: AgentJob, capRaw: bigint, data: PositionData): GrantStep => {
    if (job !== "sell" && job !== "rebalance") return { job, capRaw };
    const sellable =
      job === "rebalance"
        ? EQUITIES.map((e) => (settings?.mixBps[e.reserveId] ?? 0) > 0)
        : EQUITIES.map((e) => (agents.lastTerms.sell?.limitsRaw?.[e.reserveId] ?? 1n) > 0n);
    const prices = EQUITIES.map((e) => data.holdings[e.reserveId].priceRaw);
    return { job, capRaw, limitsRaw: stockLimitsRaw(capRaw, capMax!, prices, sellable) };
  };

  /** What renewing a job keeps: the limit of the grant it runs with, or last ran with. */
  const renewCapRaw = (job: AgentJob) => agents.terms[job]?.capRaw ?? agents.lastTerms[job]?.capRaw ?? capOf(LIMIT_USD[job].start);

  /** The JAW sheets a change takes. */
  const stepsFor = (agent: Agent, action: SheetAction, jobs?: AgentJob[]): AgentStep[] => {
    const main = AGENT_JOBS[agent][0];
    if (action === "off") return AGENT_JOBS[agent].filter((j) => agents.faceIdsOff([j]) > 0).map((j) => ({ off: j }));
    if (!position || capMax === null) return [];
    if (action === "renew") return (jobs ?? AGENT_JOBS[agent].filter((j) => agents.terms[j])).map((j) => ({ grant: grantFor(j, renewCapRaw(j), position) }));
    return [{ grant: grantFor(main, capOf(limitUsd(agent)), position) }];
  };

  // The dev preview (`?as=`) reads another account: nothing can be signed for it.
  const preview = !signer || !isAddressEqual(signer, address);
  const blocked = !live
    ? "Not live yet"
    : !!signer && fee.state === "unsupported"
      ? "Your account can’t pay network fees in USDC on Base right now."
      : capMax === null || !position
        ? "One moment…"
        : preview
          ? PREVIEW
          : null;

  /** Runs `steps` on JAW's own sheets; an error shows in the open sheet, or as a toast from a row, a card or the tab. */
  const start = (key: string, agent: Agent | null, steps: AgentStep[], message: string) => {
    if (blocked) return void toast(blocked);
    if (steps.length === 0) return;
    void runner
      .run(key, steps, () => {
        toast.success(message);
        if (agent) setPicked((p) => ({ ...p, [agent]: undefined }));
      })
      .then((error) => {
        if (error && !(agent && shown && open === agent)) toast.error(error);
      });
  };

  const act = (agent: Agent, action: SheetAction, jobs?: AgentJob[]) => {
    const name = AGENT_NAME[agent];
    const main = AGENT_JOBS[agent][0];
    const limit = limitText(action === "renew" ? toUsd(renewCapRaw(main)) : limitUsd(agent), main);
    const message = {
      on: `${name} is on`,
      off: `${name} is off`,
      limit: `${name}’s limit is ${limit}`,
      renew: `${name} runs until ${longDateText(nowSec + GRANT_SECONDS)}`,
    }[action];
    start(`${agent}:${action}`, agent, stepsFor(agent, action, jobs), message);
  };

  const openSheet = (agent: Agent) => {
    setOpen(agent);
    setShown(true);
  };
  const onSwitch = (agent: Agent, on: boolean) => {
    if (on && agent === "rebalance" && !mixSet) openSheet(agent);
    else act(agent, on ? "on" : "off");
  };

  const sheet = open && sheetFor(open);
  function sheetFor(agent: Agent) {
    const item = items.find((i) => i.agent === agent)!;
    const name = AGENT_NAME[agent];
    const ends = AGENT_JOBS[agent].map((j) => agents.terms[j]?.end ?? null).filter((e): e is number => e !== null);
    const limit: LimitView | undefined =
      agent === "save"
        ? {
            options: LIMIT_USD.save.options,
            value: limitUsd("save"),
            per: LIMIT_USD.save.per,
            onChange: (usd) => setPicked((p) => ({ ...p, save: usd })),
            changed: picked.save !== undefined && picked.save !== item.limitUsd,
          }
        : undefined;
    const activity = feed.rows.filter((r) => r.agent === name);
    return (
      <AgentSheet
        open={shown}
        onClose={() => setShown(false)}
        item={item}
        live={live}
        busy={runner.running}
        error={runner.errorFor(`${agent}:`)}
        preview={preview}
        offSteps={agents.faceIdsOff(AGENT_JOBS[agent])}
        stops={ends.length ? longDateText(Math.min(...ends)) : null}
        limit={limit}
        settings={settingsFor(agent)}
        // Protect's and Rebalance's settings carry their limit and Save, which switches them on too.
        settingsSave={agent === "protect" || agent === "rebalance"}
        activity={
          <FeedCard>
            {feed.isLoading ? (
              <div aria-busy className="py-3.5"><div className="h-10 animate-pulse rounded-[16px] bg-chip" /></div>
            ) : activity.length ? (
              <FeedDays rows={activity} nowMs={nowSec * 1000} />
            ) : (
              <p className="m-0 py-3.5 text-sm text-ink-mid">Nothing yet.</p>
            )}
          </FeedCard>
        }
        onAction={(action) => act(agent, action)}
      />
    );
  }

  function settingsFor(agent: Agent) {
    if (agent === "protect") return <ProtectSettings account={address} />;
    if (agent === "rebalance") return <RebalanceSettings account={address} />;
    if (agent === "receive") {
      return (
        <ReceiveCoins
          coins={ENTRY_COINS.map((c, k) => {
            const balance = entryRaw?.[k] ?? 0n;
            const retryAt = settings?.entryRetryAt[k] ?? 0;
            return {
              symbol: c.symbol,
              name: c.name,
              amount: balance > 0n ? (Number(balance) / 10 ** c.decimals).toLocaleString("en-US", { maximumFractionDigits: 2 }) : null,
              waitingUntil: retryAt > nowSec && balance > 0n ? timeText(retryAt) : null,
            };
          })}
        />
      );
    }
    return undefined;
  }

  const allOffSteps: AgentStep[] = JOBS.filter((j) => agents.faceIdsOff([j]) > 0).map((j) => ({ off: j }));
  const allOffIds = agents.faceIdsOff(JOBS);

  return (
    <>
      <AgentsView
        live={live}
        cards={cards.map((c) => (
          <AttentionCard key={c.key} card={c} disabled={runner.running} onRenew={(agent, jobs) => act(agent, "renew", jobs)} />
        ))}
        rows={items.map((item: AgentItem) => (
          <AgentRow
            key={item.agent}
            item={item}
            switchable={live && item.status !== "loading" && !runner.running}
            onOpen={() => openSheet(item.agent)}
            onSwitch={(on) => onSwitch(item.agent, on)}
            extra={item.agent === "rebalance" && mixSet && settings ? <MixBar mixBps={settings.mixBps} /> : undefined}
          />
        ))}
        feed={
          <AgentsFeed
            empty="Nothing yet. Your buys, credit and repayments show up here, and so will what your agents do."
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
        turnOffAll={
          <TurnOffAll
            steps={allOffIds}
            live={live}
            disabled={agents.busy || runner.running}
            onClick={() => start("all:off", null, allOffSteps, "Your agents are off")}
          />
        }
      />
      {sheet}
    </>
  );
}

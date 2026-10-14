"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { FeedCard, FeedDays } from "@/components/gg/Activity";
import { AgentConfirm, AgentSheet, ReceiveCoins, type ConfirmView, type LimitView } from "@/components/gg/AgentSheet";
import { ProtectSettings } from "@/components/gg/agents/ProtectSettings";
import { RebalanceSettings } from "@/components/gg/agents/RebalanceSettings";
import { AgentRow, AgentsFeed, AgentsView, AttentionCard, MixBar, TurnOffAll, type FeedError } from "@/components/gg/Agents";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
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
  allOffCopy,
  confirmFor,
  longDateText,
  limitText,
  timeText,
  type Agent,
  type AgentItem,
  type ConfirmCopy,
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

/** The open sheet: which agent, its confirm step if one is open, and whether a row or a card led straight to it. */
type Open = { agent: Agent; action: SheetAction | null; direct: boolean; jobs?: AgentJob[] };

/**
 * The Agents tab (Adrian, 2026-10-15). Each agent's state is the executor's registry and JAW's list (useAgents, D14);
 * its next move is the executor's `planOf` or its TypeScript rule on live data (lib/agents/next.ts); the cards come
 * from the executor's events and registry. Every switch is JAW's own screen, one Face ID each. With no executor
 * configured, everything renders with real data and nothing can be switched on ("Not live yet").
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
  const [open, setOpen] = useState<Open | null>(linked && { agent: linked, action: null, direct: false });
  const [shown, setShown] = useState(!!linked);
  const [allOff, setAllOff] = useState(false);
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

  /** The JAW screens an action takes. */
  const stepsFor = (o: Open & { action: SheetAction }): AgentStep[] => {
    const main = AGENT_JOBS[o.agent][0];
    if (o.action === "off") return AGENT_JOBS[o.agent].filter((j) => agents.faceIdsOff([j]) > 0).map((j) => ({ off: j }));
    if (!position || capMax === null) return [];
    if (o.action === "renew") {
      const jobs = o.jobs ?? AGENT_JOBS[o.agent].filter((j) => agents.terms[j]);
      return jobs.map((j) => ({ grant: grantFor(j, renewCapRaw(j), position) }));
    }
    return [{ grant: grantFor(main, capOf(limitUsd(o.agent)), position) }];
  };

  const blocked = !live
    ? "Not live yet"
    : !!signer && fee.state === "unsupported"
      ? "Your account can’t pay network fees in USDC on Base right now."
      : capMax === null || !position
        ? "One moment…"
        : null;
  // The dev preview (`?as=`) reads another account: nothing can be signed for it.
  const preview = !signer || !isAddressEqual(signer, address);

  const confirmView = (copy: ConfirmCopy, steps: AgentStep[], done: () => void): ConfirmView => ({
    ...copy,
    busy: runner.running,
    error: runner.error,
    blocked: blocked ?? (steps.length === 0 ? "Nothing to change." : null),
    preview,
    onConfirm: () => void runner.run(steps, done),
  });

  const openStep = (o: Open) => {
    runner.reset();
    setOpen(o);
    setShown(true);
  };
  const onSwitch = (agent: Agent, on: boolean) => {
    if (on && agent === "rebalance" && !mixSet) openStep({ agent, action: null, direct: false });
    else openStep({ agent, action: on ? "on" : "off", direct: true });
  };

  const sheet = open && sheetFor(open);
  function sheetFor(o: Open) {
    const item = items.find((i) => i.agent === o.agent)!;
    const name = AGENT_NAME[o.agent];
    const main = AGENT_JOBS[o.agent][0];
    const ends = AGENT_JOBS[o.agent].map((j) => agents.terms[j]?.end ?? null).filter((e): e is number => e !== null);
    const done = (message: string) => () => {
      toast.success(message);
      setPicked((p) => ({ ...p, [o.agent]: undefined }));
      if (o.direct) setShown(false);
      else setOpen({ ...o, action: null, jobs: undefined });
    };
    let confirm: ConfirmView | null = null;
    if (o.action) {
      const steps = stepsFor({ ...o, action: o.action });
      const limit = limitText(o.action === "renew" ? toUsd(renewCapRaw(main)) : limitUsd(o.agent), main);
      const untilSec = nowSec + GRANT_SECONDS;
      const faceIds = o.action === "off" ? agents.faceIdsOff(AGENT_JOBS[o.agent]) : steps.length;
      const copy = confirmFor({ kind: o.action, agent: o.agent, limit, from: item.limit, untilSec, faceIds });
      const message = { on: `${name} is on`, off: `${name} is off`, limit: `${name}’s limit is ${limit}`, renew: `${name} runs until ${longDateText(untilSec)}` }[o.action];
      confirm = confirmView(copy, steps, done(message));
    }
    const limit: LimitView | undefined =
      o.agent === "save"
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
        confirm={confirm}
        onBack={o.direct ? undefined : () => openStep({ ...o, action: null, jobs: undefined })}
        live={live}
        stops={ends.length ? longDateText(Math.min(...ends)) : null}
        limit={limit}
        settings={settingsFor(o.agent)}
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
        onAction={(action) => openStep({ ...o, action, jobs: undefined })}
        cantSwitchOn={o.agent === "rebalance" && !mixSet ? "Set your mix below first: saving it switches Rebalance on." : null}
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
          <AttentionCard key={c.key} card={c} onRenew={(agent, jobs) => openStep({ agent, action: "renew", direct: true, jobs })} />
        ))}
        rows={items.map((item: AgentItem) => (
          <AgentRow
            key={item.agent}
            item={item}
            switchable={live && item.status !== "loading"}
            onOpen={() => openStep({ agent: item.agent, action: null, direct: false })}
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
        turnOffAll={<TurnOffAll faceIds={allOffIds} live={live} disabled={agents.busy} onClick={() => (runner.reset(), setAllOff(true))} />}
      />
      {sheet}
      <SheetShell open={allOff} onOpenChange={setAllOff} title="Turn off all agents">
        <SheetSteps stepKey="all-off" className="flex flex-col gap-3.5">
          <AgentConfirm
            confirm={confirmView(allOffCopy(allOffIds), allOffSteps, () => {
              toast.success("Your agents are off");
              setAllOff(false);
            })}
          />
        </SheetSteps>
      </SheetShell>
    </>
  );
}

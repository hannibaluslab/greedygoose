"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAddressEqual, maxUint160 } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { FeedCard, FeedDays } from "@/components/gg/activity/Activity";
import { AgentSheet } from "@/components/gg/AgentSheet";
import { ProtectSettings } from "@/components/gg/agents/ProtectSettings";
import { RebalanceSettings } from "@/components/gg/agents/RebalanceSettings";
import { AgentRow, AgentsFeed, AgentsView, AttentionCard, MixBar } from "@/components/gg/Agents";
import { ProtectCardSkeleton, ProtectCardView } from "@/components/gg/agents/ProtectCard";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useActWarning } from "@/hooks/useActWarning";
import { useAgentRun, type AgentStep } from "@/hooks/useAgentRun";
import { TAP_AGAIN, useTx } from "@/hooks/useTx";
import { GRANT_SECONDS, useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { GrantStep } from "@/hooks/useManageSave";
import { useNextFreeze } from "@/hooks/useNextFreeze";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { AGENTS_LIVE } from "@/lib/agents/config";
import {
  AGENT_JOBS,
  AGENT_NAME,
  AGENTS,
  agentItems,
  agentParam,
  agentStatus,
  longDateText,
  protectWarnings,
  type Agent,
  type AgentItem,
  type Next,
  type SheetAction,
} from "@/lib/agents/list";
import { rebalanceOptions } from "@/lib/agents/mix";
import { agentNexts, defaultNumbers, pricesHeldAt, weekendCard } from "@/lib/agents/next";
import { hasLimit, JOBS, limitRaw, startCapRaw, stockLimitsRaw, type AgentJob } from "@/lib/agents/permissions";
import { protectCard } from "@/lib/agents/protectCard";
import { offSteps } from "@/lib/agents/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

export default function AgentsPage() {
  return <RequireAccount>{(address) => <Agents address={address} />}</RequireAccount>;
}

const byJob = <T,>(f: (job: AgentJob) => T) =>
  Object.fromEntries(JOBS.map((job) => [job, f(job)])) as Record<AgentJob, T>;
const LOADING = Object.fromEntries(AGENTS.map((a) => [a, { idle: "…" }])) as Record<Agent, Next>;

const PREVIEW = "Preview mode. Sign in to do this.";
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** A job or an agent that runs: on, or starting (its grant is in JAW's list, not yet in the registry). */
const runs = (s: string) => s === "on" || s === "starting";

/** What the agents' rules read off the executor's registry: nothing saved, no rescue and no plan until it's read. */
const registryInput = (settings: ReturnType<typeof useAgentSettings>) => ({
  mixBps: settings?.mixBps ?? null,
  rebalanceDay: settings?.rebalanceDay ?? 0,
  rescuing: settings?.rescuing === true,
  plan: settings?.plan ?? null,
});

/**
 * The Agents tab (Adrian, 2026-10-15): Protect and Rebalance. Each agent's state is the executor's registry and JAW's
 * list (useAgents, D14); its next move is the executor's `planOf` or its TypeScript rule on live data
 * (lib/agents/next.ts); the cards come from a plain health check, the executor's events and registry. Every switch,
 * Renew and Turn off opens JAW's own sheet straight away (its Review and Face ID), once a grant or revoke: the row or
 * the sheet already says what it does (Protect's grants are at the executor's CAP_MAX, with no amount limit; the
 * Rebalancer's at the limit it shows), so there is no confirm step of ours. Until the agents are live (AGENTS_LIVE),
 * everything renders with real data and Coming soon stands where the switches are. The feed is the agents' moves only
 * (ruling 15). Earning and turning other dollars into cash run under the hood and have no place here (D20).
 */
function Agents({ address }: { address: `0x${string}` }) {
  const { address: signer } = useAccount();
  const fee = useFeeSupport();
  const agents = useAgents(address);
  const settings = useAgentSettings(address);
  const { data: position } = usePosition(address);
  const feed = useAgentFeed(address);
  const nowSec = useNowSec();
  const freezeAt = useNextFreeze(nowSec);
  const runner = useAgentRun(agents);
  // The Finish card's write: the registrations of grants the executor doesn't run yet, prepared while the card shows.
  const finish = useTx("This didn’t go through on Base. Try again to finish turning it on.", agents.finishPlan);
  const resetFinish = finish.reset;
  const finished = finish.phase === "done" && !agents.finishPlan;
  // Registered: the write goes back to idle, so a later Finish card prepares its own batch.
  useEffect(() => {
    if (finished) resetFinish();
  }, [finished, resetFinish]);
  const live = AGENTS_LIVE;

  // The sheet keeps its last agent while it slides away. A link can name one (`/agents?agent=protect`): its sheet
  // opens on arrival, as a row's tap opens it.
  const linked = agentParam(useSearchParams().get("agent"));
  const [open, setOpen] = useState<Agent | null>(linked);
  const [shown, setShown] = useState(!!linked);

  const capMax = agents.capMaxRaw;
  const capOf = (usd: number) => limitRaw(usd, capMax ?? BigInt(usd) * 10n ** BigInt(USDC.decimals));
  /**
   * The cap a job starts on: CAP_MAX for Protect's two jobs (no amount limit), else its starting limit. Until CAP_MAX
   * is read nothing is granted, and the rules run on the largest a grant could hold.
   */
  const startCap = (job: AgentJob) => startCapRaw(job, capMax ?? maxUint160);
  const mixSet = !!settings?.mixBps.some((w) => w > 0);

  const numbers = settings?.numbers ?? defaultNumbers(rebalanceOptions());
  const next = position
    ? agentNexts({
        nowSec,
        savingsRaw: position.savingsRaw,
        totalBackingUsd: position.totalBackingUsd,
        avgCf: position.avgCf,
        debtUsd: position.debtUsd,
        holdings: position.holdings,
        ...registryInput(settings),
        left: agents.left,
        capRaw: byJob((job) => agents.terms[job]?.capRaw ?? startCap(job)),
        capMaxRaw: capMax,
        numbers,
        sellOn: runs(agents.status.sell),
        pricesHeld: pricesHeldAt(nowSec, freezeAt),
      })
    : LOADING;
  const items = agentItems({ status: agents.status, capRaw: byJob((job) => agents.terms[job]?.capRaw ?? null), next });

  // The Act warning: a plain health check, Protect on or off (Adrian, 2026-10-19). A card only.
  const protectRuns = runs(agentStatus("protect", agents.status));
  const actCard = useActWarning(address, numbers, protectRuns);
  // The weekend card: a card only, while Protect runs, as Weekend Shield did.
  const weekend =
    position && protectRuns
      ? weekendCard({
          nowSec,
          freezeAt,
          totalBackingUsd: position.totalBackingUsd,
          avgCf: position.avgCf,
          debtUsd: position.debtUsd,
          numbers,
        })
      : null;

  // Off without the user turning it off: its grant ran out, or the executor switched it off.
  const stoppedAt = (job: AgentJob) => {
    const last = feed.switched[job];
    if (agents.status[job] !== "off" || last?.byUser) return null;
    const at = Math.max(agents.ranOut[job] ?? 0, last && !last.on ? last.at : 0);
    return at > 0 ? at : null;
  };
  // Protect's card carries what the warning cards used to say; their Top up and Repay live in its sheet. It reads
  // Protect as one agent, both its jobs, as its sheet, the Act warning and the weekend card do.
  const protectEnds = AGENT_JOBS.protect.flatMap((j) => (agents.terms[j] ? [agents.terms[j].end] : []));
  const protectStops = AGENT_JOBS.protect.flatMap((j) => stoppedAt(j) ?? []);
  const protect = protectCard({
    live,
    nowSec,
    status: agentStatus("protect", agents.status),
    waiting: (["protect", "sell"] as const).find((j) => agents.toFinish.includes(j)) ?? null,
    hf: position?.healthFactor ?? null,
    rescuing: settings?.rescuing === true,
    fails: agents.fails,
    cooldownUntil: agents.cooldownUntil,
    stoppedAt: protectRuns || protectStops.length === 0 ? null : Math.max(...protectStops),
    endsAt: protectEnds.length > 0 ? Math.min(...protectEnds) : null,
    act: actCard,
    weekend,
    next: next.protect,
    triggerHf: numbers.triggerHf,
    targetHf: numbers.targetHf,
  });
  const warnings = protectWarnings({ act: actCard, weekend });
  /**
   * The Rebalancer's row line, until its own card lands: failed runs while Protect's card doesn't say so (Protect off),
   * and a stop on its own, which the old tab's cards said.
   */
  const rebalanceStop = stoppedAt("rebalance");
  const rebalanceLine = (line: string) =>
    rebalanceStop !== null
      ? `Stopped on ${SHORT_DATE.format(rebalanceStop * 1000)}`
      : !protectRuns && runs(agents.status.rebalance) && agents.fails >= 3
        ? `Its last ${agents.fails} runs didn’t go through. Nothing moved.`
        : line;

  /** The cap an agent's switch grants: the Rebalancer's limit on its row; Protect's CAP_MAX (no amount limit). */
  const switchCap = (agent: Agent) => {
    const usd = items.find((i) => i.agent === agent)!.limitUsd;
    return usd === null ? startCap(AGENT_JOBS[agent][0]) : capOf(usd);
  };

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

  /**
   * What renewing a job keeps: the limit of the grant it runs with, or last ran with. Protect's two jobs renew at
   * CAP_MAX, with no amount limit, whatever a grant from before carried.
   */
  const renewCapRaw = (job: AgentJob) =>
    hasLimit(job) ? (agents.terms[job]?.capRaw ?? agents.lastTerms[job]?.capRaw ?? startCap(job)) : startCap(job);

  /** Turning `jobs` off: a revoke for each with a grant to revoke, or why it can't go ahead (the list is unreadable). */
  const offFor = (jobs: readonly AgentJob[]) =>
    offSteps(
      jobs,
      (j) => agents.status[j],
      (j) => agents.faceIdsOff([j]),
      agents.listUnreadable,
    );

  /** The JAW sheets a change takes. */
  const stepsFor = (agent: Agent, action: SheetAction, jobs?: AgentJob[]): AgentStep[] => {
    const main = AGENT_JOBS[agent][0];
    if (action === "off") return offFor(AGENT_JOBS[agent]).steps;
    if (!position || capMax === null) return [];
    if (action === "renew")
      return (jobs ?? AGENT_JOBS[agent].filter((j) => agents.terms[j])).map((j) => ({
        grant: grantFor(j, renewCapRaw(j), position),
      }));
    return [{ grant: grantFor(main, switchCap(agent), position) }];
  };

  // The dev preview (`?as=`) reads another account: nothing can be signed for it.
  const preview = !signer || !isAddressEqual(signer, address);
  const blocked = !live
    ? "Coming soon"
    : !!signer && fee.state === "unsupported"
      ? "Your account can’t pay network fees from your cash right now."
      : capMax === null || !position
        ? "One moment…"
        : preview
          ? PREVIEW
          : null;

  /**
   * Runs `steps` on JAW's own sheets; an error shows in the open sheet, or as a toast from a row, a card or the tab.
   * `stop`: why the change can't go ahead at all (turning off while the list can't be read), said instead of nothing.
   */
  const start = (key: string, agent: Agent | null, steps: AgentStep[], message: string, stop?: string | null) => {
    if (blocked) return void toast(blocked);
    if (stop) return void toast.error(stop);
    if (steps.length === 0) return;
    void runner
      .run(key, steps, () => toast.success(message))
      .then((error) => {
        if (!error || (agent && shown && open === agent)) return;
        // A sheet JAW couldn't open isn't a failure: the same control opens it on the next tap.
        if (error.endsWith(TAP_AGAIN)) toast(error);
        else toast.error(error);
      });
  };

  const act = (agent: Agent, action: SheetAction, jobs?: AgentJob[]) => {
    const name = AGENT_NAME[agent];
    const message = {
      on: `${name} is on`,
      off: `${name} is off`,
      renew: `${name} runs until ${longDateText(nowSec + GRANT_SECONDS)}`,
    }[action];
    const stop = action === "off" ? offFor(AGENT_JOBS[agent]).error : null;
    start(`${agent}:${action}`, agent, stepsFor(agent, action, jobs), message, stop);
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
    const activity = feed.rows.filter((r) => r.by === name);
    return (
      <AgentSheet
        open={shown}
        onClose={() => setShown(false)}
        item={item}
        live={live}
        busy={runner.running}
        error={runner.errorFor(`${agent}:`)}
        offSteps={agents.faceIdsOff(AGENT_JOBS[agent])}
        stops={ends.length ? longDateText(Math.min(...ends)) : null}
        // Each settings body carries Save, which switches it on too (and the Rebalancer's, its limit).
        settings={agent === "protect" ? <ProtectSettings account={address} /> : <RebalanceSettings account={address} />}
        activity={
          <FeedCard>
            {feed.isLoading ? (
              <div aria-busy className="py-3.5">
                <div className="h-10 animate-pulse rounded-[16px] bg-chip" />
              </div>
            ) : activity.length ? (
              <FeedDays rows={activity} nowMs={nowSec * 1000} />
            ) : (
              <p className="m-0 py-3.5 text-sm text-ink-mid">Nothing yet.</p>
            )}
          </FeedCard>
        }
        onAction={(action) => act(agent, action)}
        warnings={
          agent === "protect" && warnings.length > 0
            ? warnings.map((c) => <AttentionCard key={c.key} card={c} onLeave={() => setShown(false)} />)
            : undefined
        }
        finish={
          live && AGENT_JOBS[agent].some((j) => agents.toFinish.includes(j))
            ? {
                onFinish: () => void finish.sign(),
                busy: finish.busy,
                waiting: finish.checking || finish.blocked,
                error: finish.error,
              }
            : undefined
        }
      />
    );
  }

  return (
    <>
      <AgentsView
        live={live}
        signed={!!agents.terms.rebalance}
        protect={
          !position || (live && agents.status.protect === "loading") ? (
            <ProtectCardSkeleton onOpen={() => openSheet("protect")} />
          ) : (
            <ProtectCardView model={protect} onOpen={() => openSheet("protect")} />
          )
        }
        rebalance={items
          .filter((item: AgentItem) => item.agent === "rebalance")
          .map((item: AgentItem) => (
            <AgentRow
              key={item.agent}
              item={{ ...item, line: rebalanceLine(item.line) }}
              live={live}
              switchable={live && item.status !== "loading" && !runner.running}
              onOpen={() => openSheet(item.agent)}
              onSwitch={(on) => onSwitch(item.agent, on)}
              extra={mixSet && settings ? <MixBar mixBps={settings.mixBps} /> : undefined}
            />
          ))}
        feed={
          <AgentsFeed
            empty="Nothing yet. What your agents do, and why, shows up here."
            nowMs={nowSec * 1000}
            rows={feed.rows}
            loading={feed.isLoading}
            error={feed.isError ? "all" : null}
            onRetry={feed.refetch}
            more={feed.more}
            onShowEarlier={feed.showEarlier}
          />
        }
      />
      {sheet}
    </>
  );
}

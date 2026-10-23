"use client";

import { useHealthDayAgo } from "@/hooks/useHealthDayAgo";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { FeedCard, FeedDays } from "@/components/gg/activity/Activity";
import { AgentSheet } from "@/components/gg/AgentSheet";
import { ProtectSettings } from "@/components/gg/agents/ProtectSettings";
import { RebalanceSheet } from "@/components/gg/agents/RebalanceSheet";
import { AgentsFeed, AgentsView, AttentionCard } from "@/components/gg/Agents";
import { ProtectCardSkeleton, ProtectCardView } from "@/components/gg/agents/ProtectCard";
import { RebalanceCard } from "@/components/gg/agents/RebalanceCard";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useActWarning } from "@/hooks/useActWarning";
import { useTx } from "@/hooks/useTx";
import { GRANT_SECONDS, useAgents, type GrantStep } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useNextFreeze } from "@/hooks/useNextFreeze";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition } from "@/hooks/usePosition";
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
  type Next,
} from "@/lib/agents/list";
import { rebalanceOptions } from "@/lib/agents/mix";
import { agentNexts, defaultNumbers, weekendCard } from "@/lib/agents/next";
import { stockLimitsRaw, type AgentJob } from "@/lib/agents/permissions";
import { refusedInARow } from "@/lib/agents/feed";
import { protectCard } from "@/lib/agents/protectCard";
import { EQUITIES } from "@/lib/tokens/registry";

export default function AgentsPage() {
  return <RequireAccount>{(address) => <Agents address={address} />}</RequireAccount>;
}

const LOADING = Object.fromEntries(AGENTS.map((a) => [a, { idle: "…" }])) as Record<Agent, Next>;

const PREVIEW = "Preview mode. Sign in to do this.";

/** A job or an agent that runs: on, or starting (its grant is in JAW's list, not yet in the registry). */
const runs = (s: string) => s === "on" || s === "starting";

/** What the agents' rules read off GooseGuard and the Planner: nothing saved, no rescue and no plan until it's read. */
const registryInput = (settings: ReturnType<typeof useAgentSettings>) => ({
  mixBps: settings?.mixBps ?? null,
  pacing: settings?.pacing ?? { sessionAt: 0, mixSetAt: 0 },
  rescuing: settings?.rescuing === true,
  plan: settings?.plan ?? null,
});

/**
 * The Agents tab (Adrian, 2026-10-15): Protect and Rebalance. Each agent's state is read on Base (useAgents: GooseGuard
 * and the manager); its next move is the Planner's `planOf` or its TypeScript rule on live data (lib/agents/next.ts);
 * the cards come from a plain health check, the Guard's events and its account state. Renew and Turn
 * off in an agent's sheet are one batch each, one Face ID (useAgents `changePlan`), prepared while the sheet is open
 * so the tap opens JAW's sheet at once; switching on is the sheet's own Save. Until the agents are live (AGENTS_LIVE),
 * everything renders with real data and Coming soon stands where the switches are. The feed is the agents' moves only
 * (ruling 15). Earning and turning other dollars into cash run under the hood and have no place here (D20).
 */
function Agents({ address }: { address: `0x${string}` }) {
  const { address: signer } = useAccount();
  const fee = useFeeSupport();
  const agents = useAgents(address);
  const settings = useAgentSettings(address);
  const { data: position } = usePosition(address);
  const hfDayAgo = useHealthDayAgo(address);
  const feed = useAgentFeed(address);
  const nowSec = useNowSec();
  const freezeAt = useNextFreeze(nowSec);
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
        numbers,
        sellOn: runs(agents.status.sell),
      })
    : LOADING;
  const items = agentItems({
    status: agents.status,
    next,
    protect: { line: numbers.triggerHf, target: numbers.targetHf },
  });

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

  // Off without the user turning it off: its grant ran out.
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
  // "Retrying" counts Protect's own moves the Guard refused in a row, read from its events (no failure counter).
  const refused = refusedInARow(feed.events);
  const protect = protectCard({
    live,
    nowSec,
    status: agentStatus("protect", agents.status),
    waiting: (["protect", "sell"] as const).find((j) => agents.toFinish.includes(j)) ?? null,
    hf: position?.healthFactor ?? null,
    hfDayAgo,
    rescuing: settings?.rescuing === true,
    refused: refused.protect,
    stoppedAt: protectRuns || protectStops.length === 0 ? null : Math.max(...protectStops),
    endsAt: protectEnds.length > 0 ? Math.min(...protectEnds) : null,
    act: actCard,
    weekend,
    next: next.protect,
    triggerHf: numbers.triggerHf,
    targetHf: numbers.targetHf,
  });
  const warnings = protectWarnings({ act: actCard, weekend });

  /** A job's grant again, with no limit; a job that sells stock names the stocks it may sell. */
  const grantFor = (job: AgentJob): GrantStep => {
    if (job !== "sell" && job !== "rebalance") return { job };
    // The Rebalancer sells what's in its mix; until the mix is read, what its running grant may sell.
    const mixSet = !!settings?.mixBps.some((w) => w > 0);
    const sellable =
      job === "rebalance"
        ? EQUITIES.map((e) =>
            mixSet
              ? (settings?.mixBps[e.reserveId] ?? 0) > 0
              : (agents.terms.rebalance?.limitsRaw?.[e.reserveId] ?? 0n) > 0n,
          )
        : EQUITIES.map((e) => (agents.lastTerms.sell?.limitsRaw?.[e.reserveId] ?? 1n) > 0n);
    return { job, limitsRaw: stockLimitsRaw(sellable) };
  };

  // The dev preview (`?as=`) reads another account: nothing can be signed for it.
  const preview = !signer || !isAddressEqual(signer, address);
  const blocked = !live
    ? "Coming soon"
    : !!signer && fee.state === "unsupported"
      ? "Your account can’t pay network fees from your cash right now."
      : !position
        ? "One moment…"
        : preview
          ? PREVIEW
          : null;

  // The open sheet's two writes, each one batch prepared while it shows: Turn off (every live grant of its jobs
  // revoked) and Renew (each of its running jobs granted again for a year, the grant it replaces revoked).
  const sheetAgent = shown && open && live && !blocked ? open : null;
  const offJobs = sheetAgent ? AGENT_JOBS[sheetAgent] : [];
  // A plan that says why when Base or JAW's list can't be read (useAgents), so Turn off never does nothing in silence.
  const offPlan =
    sheetAgent && offJobs.some((j) => runs(agents.status[j])) ? agents.changePlan({ off: offJobs }) : null;
  const renewJobs = sheetAgent ? AGENT_JOBS[sheetAgent].filter((j) => agents.terms[j]) : [];
  const renewPlan =
    sheetAgent && position && renewJobs.length > 0 ? agents.changePlan({ grants: renewJobs.map(grantFor) }) : null;
  const turnOff = useTx("This didn’t go through on Base. Nothing changed. Try again.", offPlan);
  const renew = useTx("This didn’t go through on Base. Nothing changed. Try again.", renewPlan);
  // Which agent each write was tapped for: its toast, its busy state and its error belong to that agent's sheet.
  const [tapped, setTapped] = useState<{ off: Agent | null; renew: Agent | null }>({ off: null, renew: null });
  // Each landed: said once, for the agent it was tapped for, and the write goes back to idle for the next time.
  const said = useRef<{ off: boolean; renew: boolean }>({ off: false, renew: false });
  useEffect(() => {
    if (turnOff.phase !== "done") return void (said.current.off = false);
    if (said.current.off || !tapped.off) return;
    said.current.off = true;
    toast.success(`${AGENT_NAME[tapped.off]} is off`);
    turnOff.reset();
  }, [turnOff, tapped.off]);
  useEffect(() => {
    if (renew.phase !== "done") return void (said.current.renew = false);
    if (said.current.renew || !tapped.renew) return;
    said.current.renew = true;
    toast.success(`${AGENT_NAME[tapped.renew]} runs until ${longDateText(nowSec + GRANT_SECONDS)}`);
    renew.reset();
    // The date is said as it lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renew, tapped.renew]);

  const act = (action: "off" | "renew") => {
    if (blocked) return void toast(blocked);
    const plan = action === "off" ? offPlan : renewPlan;
    // No batch yet: still reading what it's built from, or, shown on with nothing left to revoke, a turn-off this page
    // sent is still on its way to Base.
    if (!plan) {
      const sent = action === "off" && open !== null && agents.toTurnOff(AGENT_JOBS[open]) === 0;
      return void toast(sent ? "It’s turning off. This can take a moment." : "One moment…");
    }
    setTapped((t) => ({ ...t, [action]: open }));
    void (action === "off" ? turnOff.sign() : renew.sign());
  };

  const openSheet = (agent: Agent) => {
    setOpen(agent);
    setShown(true);
  };

  const sheet = open && sheetFor(open);
  function sheetFor(agent: Agent) {
    const item = items.find((i) => i.agent === agent)!;
    const name = AGENT_NAME[agent];
    const ends = AGENT_JOBS[agent].map((j) => agents.terms[j]?.end ?? null).filter((e): e is number => e !== null);
    const activity = feed.rows.filter((r) => r.by === name);
    const busy = (turnOff.busy && tapped.off === agent) || (renew.busy && tapped.renew === agent);
    const confirming =
      (turnOff.phase === "pending" && tapped.off === agent) || (renew.phase === "pending" && tapped.renew === agent);
    const error = (tapped.off === agent ? turnOff.error : null) ?? (tapped.renew === agent ? renew.error : null);
    const finishing =
      live && AGENT_JOBS[agent].some((j) => agents.toFinish.includes(j))
        ? {
            onFinish: () => void finish.sign(),
            busy: finish.busy,
            confirming: finish.phase === "pending",
            waiting: finish.checking || finish.blocked,
            error: finish.error,
          }
        : undefined;
    // Rebalance's own sheet (boards 7e–7h): My mix and Top-ups go into my mix, with Turn off, Renew and Finish here.
    if (agent === "rebalance")
      return (
        <RebalanceSheet
          account={address}
          open={shown}
          onClose={() => setShown(false)}
          busy={busy}
          confirming={confirming}
          error={error}
          onAction={act}
          finish={finishing}
        />
      );
    return (
      <AgentSheet
        open={shown}
        onClose={() => setShown(false)}
        item={item}
        live={live}
        busy={busy}
        confirming={confirming}
        error={error}
        stops={ends.length ? longDateText(Math.min(...ends)) : null}
        // Its settings body carries Save, which switches it on too.
        settings={<ProtectSettings account={address} />}
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
        onAction={(action) => action !== "on" && act(action)}
        warnings={
          agent === "protect" && warnings.length > 0
            ? warnings.map((c) => <AttentionCard key={c.key} card={c} onLeave={() => setShown(false)} />)
            : undefined
        }
        finish={finishing}
      />
    );
  }

  return (
    <>
      <AgentsView
        live={live}
        numbers={{ line: numbers.triggerHf, target: numbers.targetHf }}
        protect={
          !position || (live && agents.status.protect === "loading") ? (
            <ProtectCardSkeleton onOpen={() => openSheet("protect")} />
          ) : (
            <ProtectCardView model={protect} onOpen={() => openSheet("protect")} />
          )
        }
        rebalance={<RebalanceCard account={address} onOpen={() => openSheet("rebalance")} />}
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

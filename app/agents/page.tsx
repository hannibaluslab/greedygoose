"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAccount } from "wagmi";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { FeedCard, FeedDays } from "@/components/gg/Activity";
import { AgentPill } from "@/components/gg/Status";
import { Switch } from "@/components/gg/Switch";
import { ChevronRight, PadlockIcon, RebalanceIcon, ShieldIcon } from "@/components/gg/icons";
import { useAgents } from "@/hooks/useAgents";
import { useActivity } from "@/hooks/useActivity";
import { useNowSec } from "@/hooks/useNowSec";
import { DAILY_LIMIT_USD, JOBS, type AgentJob } from "@/lib/agents/permissions";
import { toUsd } from "@/lib/cash";
import { formatUsdTrim } from "@/lib/formatting";

export default function AgentsPage() {
  return <RequireAccount>{(address) => <Agents address={address} />}</RequireAccount>;
}

/**
 * Design board "7 · Agents" (Agents.dc.html). The Cash Agent's two jobs switch on and off through JAW's own
 * permission screens (useAgents, D14); it shows "Not live yet" until GooseExecutor is deployed. The Rebalancer comes
 * later. Activity is the account's own moves, from JAW's history and Base receipts; agents' moves join it once the
 * executor runs.
 */
function Agents({ address }: { address: `0x${string}` }) {
  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[54px] leading-[normal]">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">Agents</h1>
        <p className="m-0 text-sm leading-[1.4] text-ink-mid">What they did, and why.</p>
      </div>

      <div className="flex flex-col gap-2">
        <CashAgent address={address} />
        <div className="flex items-center gap-2.5 rounded-[22px] bg-card px-3 py-2.5 shadow-card-elev">
          <AgentMark tone="bone"><RebalanceIcon /></AgentMark>
          <AgentTitle name="Rebalancer" pill={<AgentPill>Coming later</AgentPill>} sub="Keeps your mix" />
        </div>
      </div>

      <Feed address={address} />

      <p className="m-0 flex items-center justify-center gap-1.5 text-xs text-subtle">
        <PadlockIcon />
        <span>Limits you signed with Face ID. Enforced by <span className="font-bold text-ink">JAW.id</span>.</span>
      </p>

      <TabBar />
    </div>
  );
}

const JOB: Record<AgentJob, { name: string; does: string }> = {
  save: { name: "Save", does: "Puts new cash into savings so it earns" },
  protect: { name: "Protection", does: "Repays from your cash if credit reaches Watch" },
};

/** Save and Protection, each its own JAW grant and Face ID. Cash is savings (D15), so both work on the user's cash. */
function CashAgent({ address }: { address: `0x${string}` }) {
  const { isConnected } = useAccount();
  const agents = useAgents(address);
  const s = Object.values(agents.status);
  const pill = s.includes("unconfigured")
    ? "Not live yet"
    : s.includes("loading")
      ? "…"
      : s.includes("on")
        ? "On"
        : s.includes("starting")
          ? "Starting"
          : "Off";
  const cancelled = /reject|denied|cancel/i.test(agents.error?.message ?? "");

  const limit = (job: AgentJob) => {
    const raw = agents.capRaw[job] ?? agents.limitRaw[job];
    return formatUsdTrim(raw === null ? DAILY_LIMIT_USD[job] : toUsd(raw));
  };
  const toggle = (job: AgentJob, on: boolean) => {
    const limitRaw = agents.limitRaw[job];
    // The hook keeps the error for the screen; nothing else to do with the rejection here.
    if (!on) void agents.turnOff(job).catch(() => {});
    else if (limitRaw !== null) void agents.turnOn(job, limitRaw).catch(() => {});
  };

  return (
    <div className="rounded-[22px] bg-card px-3 pt-2.5 shadow-card-elev">
      <Link href="/guardian" aria-label={`Cash Agent, ${pill}. Open your savings`} className="flex items-center gap-2.5 text-ink no-underline">
        <AgentMark tone="lime"><ShieldIcon size={19} strokeWidth={1.9} /></AgentMark>
        <AgentTitle name="Cash Agent" pill={<AgentPill on={pill === "On"}>{pill}</AgentPill>} sub="Saves your cash · guards your credit" />
        <ChevronRight size={16} className="shrink-0 text-subtle" />
      </Link>
      <div className="mt-2.5 border-t border-hairline">
        {JOBS.map((job, i) => {
          const status = agents.status[job];
          return (
            <div key={job} className={`flex items-center gap-3 py-[13px] ${i ? "border-t border-hairline" : ""}`}>
              <div className="flex grow flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{JOB[job].name}</span>
                <span className="text-xs leading-[1.35] text-subtle">
                  {JOB[job].does} · up to {limit(job)} a day{status === "starting" ? " · starting" : ""}
                </span>
              </div>
              <Switch
                label={JOB[job].name}
                checked={status === "on" || status === "starting"}
                disabled={!isConnected || status === "unconfigured" || status === "loading" || agents.busy}
                onChange={(on) => toggle(job, on)}
              />
            </div>
          );
        })}
      </div>
      {(agents.fails > 0 || agents.error) && (
        <p role="status" className="m-0 border-t border-hairline py-2.5 text-xs leading-[1.35] text-act">
          {agents.error
            ? cancelled
              ? "You cancelled. Nothing changed."
              : "We couldn’t change that right now. Try again."
            : `The last ${agents.fails === 1 ? "run" : `${agents.fails} runs`} didn’t go through. It tries again soon.`}
        </p>
      )}
    </div>
  );
}

function AgentMark({ tone, children }: { tone: "lime" | "bone"; children: ReactNode }) {
  return (
    <span aria-hidden className={`flex size-[38px] shrink-0 items-center justify-center rounded-[19px] text-ink ${tone === "lime" ? "bg-brand" : "bg-card-bone"}`}>
      {children}
    </span>
  );
}

function AgentTitle({ name, pill, sub }: { name: string; pill: ReactNode; sub: string }) {
  return (
    <span className="flex min-w-0 grow flex-col gap-0.5">
      <span className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold">{name}</span>
        {pill}
      </span>
      <span className="whitespace-nowrap text-[13px] text-subtle">{sub}</span>
    </span>
  );
}

function Feed({ address }: { address: `0x${string}` }) {
  const { rows, isLoading, isError, refetch } = useActivity(address);
  const nowMs = useNowSec() * 1000;

  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="label m-0 px-1">Activity</h2>
      <FeedCard>
        {isLoading ? (
          <div aria-busy className="flex flex-col gap-3 py-3.5">
            {[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-[16px] bg-chip" />)}
          </div>
        ) : isError ? (
          <div className="py-3.5">
            <p role="alert" className="m-0 text-sm text-ink-2">We couldn’t load your activity.</p>
            <button type="button" onClick={() => refetch()} className="mt-2.5 h-10 rounded-[20px] bg-chip px-4 text-sm font-semibold">
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="m-0 py-3.5 text-sm leading-[1.4] text-ink-mid">
            Nothing yet. Your buys, credit and repayments show up here, and so will what your agents do.
          </p>
        ) : (
          <FeedDays rows={rows} nowMs={nowMs} />
        )}
      </FeedCard>
    </section>
  );
}

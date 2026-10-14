"use client";

import type { ReactNode } from "react";
import { AgentMark, FeedCard, FeedDays, type FeedRow } from "./Activity";
import { Button } from "./Button";
import { TabHeader } from "./Screen";
import { stockColor } from "./StockAvatar";
import { Switch } from "./Switch";
import { TabBar } from "./TabBar";
import { ChevronRight, PadlockIcon } from "./icons";
import { NOT_LIVE, type Agent, type AgentCard, type AgentItem, type CardAction } from "@/lib/agents/list";
import type { AgentJob } from "@/lib/agents/permissions";
import { EQUITIES } from "@/lib/tokens/registry";

/*
 * The Agents tab (Adrian, 2026-10-15): cards only when something needs the user, the four agents with their
 * switches, what they did and why, and one way to turn them all off. Plain values in, so the dev gallery draws every
 * state.
 */

export function AgentsView({
  cards, rows, live, feed, turnOffAll,
}: {
  cards: ReactNode;
  rows: ReactNode;
  /** Whether an executor is configured: until then nothing can be switched on. */
  live: boolean;
  feed: ReactNode;
  turnOffAll: ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[54px] leading-[normal]">
      <TabHeader title="Agents" />
      {cards}
      <section aria-label="Your agents" className="flex flex-col gap-2">
        {rows}
        {!live && <p className="m-0 px-1 text-xs leading-[1.4] text-subtle">{NOT_LIVE}</p>}
      </section>
      {feed}
      {turnOffAll}
      <p className="m-0 flex items-center justify-center gap-1.5 text-xs text-subtle">
        <PadlockIcon />
        <span>
          Limits you signed with Face ID. Enforced by <span className="font-bold text-ink">JAW.id</span>.
        </span>
      </p>
      <TabBar />
    </div>
  );
}

const TONE: Record<AgentCard["tone"], string> = {
  watch: "bg-watch-soft",
  act: "bg-neg-soft",
  plain: "bg-card shadow-card-elev",
};

/** A card that needs the user: one sentence, and one or two ways to act on it. */
export function AttentionCard({ card, onRenew }: { card: AgentCard; onRenew: (agent: Agent, jobs: AgentJob[]) => void }) {
  const urgent = card.tone !== "plain";
  const button = (a: CardAction, i: number) =>
    a.kind === "link" ? (
      <Button key={a.label} variant={i === 0 ? "dark" : "primary"} href={a.href}>
        {a.label}
      </Button>
    ) : (
      <button key="renew" type="button" onClick={() => onRenew(a.agent, a.jobs)} className="flex h-9 shrink-0 items-center rounded-[18px] bg-ink px-4 text-sm font-semibold text-on-ink">
        Renew
      </button>
    );
  const single = card.actions.length === 1 && card.actions[0].kind === "renew";
  return (
    <section aria-label={`${card.agent} needs you`} className={`flex flex-col gap-3 rounded-[22px] p-3.5 ${TONE[card.tone]}`}>
      <div className="flex items-center gap-2.5">
        <AgentMark agent={card.agent} size={32} />
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <p role={urgent ? "alert" : undefined} className="m-0 text-[15px] font-semibold leading-[1.3]">
            {card.text}
          </p>
          {card.sub && <p className="m-0 text-[13px] leading-[1.35] text-ink-2">{card.sub}</p>}
        </div>
        {single && button(card.actions[0], 0)}
      </div>
      {!single && card.actions.length > 0 && <div className="grid grid-cols-2 gap-2">{card.actions.map(button)}</div>}
    </section>
  );
}

/** Rebalance's mix, as a 4px bar in each stock's colour. */
export function MixBar({ mixBps }: { mixBps: readonly number[] }) {
  const set = EQUITIES.filter((e) => mixBps[e.reserveId] > 0).sort((a, b) => mixBps[b.reserveId] - mixBps[a.reserveId]);
  return (
    <span
      role="img"
      aria-label={`Your mix: ${set.map((e) => `${e.name} ${mixBps[e.reserveId] / 100}%`).join(", ")}`}
      className="mt-1 flex h-1 w-full max-w-[160px] gap-px overflow-hidden rounded-[2px]"
    >
      {set.map((e) => (
        <span key={e.symbol} style={{ flex: mixBps[e.reserveId], background: stockColor(e.symbol) }} />
      ))}
    </span>
  );
}

/**
 * One agent: its mark, name and what it does, its switch, then what it does next and its limit. The row opens the
 * agent's sheet; the switch opens its confirm step (one Face ID, JAW's own screen).
 */
export function AgentRow({
  item, switchable, onOpen, onSwitch, extra,
}: {
  item: AgentItem;
  switchable: boolean;
  onOpen: () => void;
  onSwitch: (on: boolean) => void;
  /** Under what it does: Rebalance's mix bar. */
  extra?: ReactNode;
}) {
  return (
    <div className="relative rounded-[22px] bg-card shadow-card-elev">
      <button type="button" onClick={onOpen} aria-label={`${item.name}: ${item.line}. Open`} className="absolute inset-0 rounded-[22px]" />
      <div className="pointer-events-none relative flex items-center gap-2.5 px-3 pb-2.5 pt-3">
        <AgentMark agent={item.name} size={38} />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-base font-semibold">{item.name}</span>
          <span className="truncate text-[13px] text-subtle">{item.does}</span>
          {extra}
        </span>
        <span className="pointer-events-auto">
          <Switch label={`${item.name} ${item.on ? "on" : "off"}`} checked={item.on} disabled={!switchable} onChange={onSwitch} />
        </span>
      </div>
      <div className="pointer-events-none relative flex items-center gap-2 border-t border-hairline py-2.5 pl-3 pr-2.5">
        <span className="num min-w-0 grow truncate text-[13px] text-ink-2">{item.line}</span>
        <span className="num flex h-[22px] shrink-0 items-center rounded-[11px] bg-pill px-2 text-xs font-semibold text-ink-mid">{item.limit}</span>
        <ChevronRight size={16} className="shrink-0 text-subtle" />
      </div>
    </div>
  );
}

/** "Turn off all agents", honest about how many Face IDs it takes. */
export function TurnOffAll({ faceIds, live, disabled, onClick }: { faceIds: number; live: boolean; disabled: boolean; onClick: () => void }) {
  const note = !live ? "Not live yet" : faceIds === 0 ? "None of them is on." : faceIds === 1 ? "One Face ID" : `${faceIds} Face IDs, one for each limit you signed`;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button type="button" disabled={disabled || faceIds === 0} onClick={onClick} className="flex h-11 items-center px-4 text-sm font-semibold text-act disabled:text-ink-mid disabled:opacity-60">
        Turn off all agents
      </button>
      <span className="text-xs text-subtle">{note}</span>
    </div>
  );
}

/** Which part of the feed couldn't be read: all of it, or only the agents' moves or the user's own. */
export type FeedError = "all" | "agents" | "yours" | null;

const NOTICE: Record<Exclude<FeedError, null>, string> = {
  all: "We couldn’t load your activity.",
  agents: "We couldn’t load what your agents did.",
  yours: "We couldn’t load your own moves.",
};

/** What they did, and why: the user's moves and the agents', by day, with loading, empty and error states. */
export function AgentsFeed({
  title = "What they did, and why", empty, rows, nowMs, loading, error, onRetry, more, onShowEarlier,
}: {
  title?: string;
  empty: string;
  rows: readonly FeedRow[];
  nowMs: number;
  loading: boolean;
  error: FeedError;
  onRetry: () => void;
  /** Older weeks of agent moves to read. */
  more: boolean;
  onShowEarlier: () => void;
}) {
  const retry = (
    <button type="button" onClick={onRetry} className="h-10 shrink-0 rounded-[20px] bg-chip px-4 text-sm font-semibold">
      Try again
    </button>
  );
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="label m-0 px-1">{title}</h2>
      <FeedCard>
        {loading ? (
          <div aria-busy className="flex flex-col gap-3 py-3.5">
            {[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-[16px] bg-chip" />)}
          </div>
        ) : error === "all" ? (
          <div className="py-3.5">
            <p role="alert" className="m-0 mb-2.5 text-sm text-ink-2">{NOTICE.all}</p>
            {retry}
          </div>
        ) : (
          <>
            {error && (
              <div className="flex items-center justify-between gap-3 border-b border-hairline py-2.5">
                <p role="alert" className="m-0 text-[13px] leading-[1.35] text-ink-2">{NOTICE[error]}</p>
                {retry}
              </div>
            )}
            {rows.length === 0 ? <p className="m-0 py-3.5 text-sm leading-[1.4] text-ink-mid">{empty}</p> : <FeedDays rows={rows} nowMs={nowMs} />}
            {more && (
              <button type="button" onClick={onShowEarlier} className="flex h-11 w-full items-center justify-center border-t border-hairline text-[13px] font-semibold">
                Show earlier
              </button>
            )}
          </>
        )}
      </FeedCard>
    </section>
  );
}

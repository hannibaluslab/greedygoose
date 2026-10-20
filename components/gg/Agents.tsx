"use client";

import type { ReactNode } from "react";
import { AgentMark, FeedCard, FeedDays, type FeedRow } from "./activity/Activity";
import { Button } from "./kit/Button";
import { useMoneySheets } from "./cash/MoneySheets";
import { TabHeader } from "./Screen";
import { stockColor } from "./kit/StockAvatar";
import { Switch } from "./kit/Switch";
import { TabBar } from "./TabBar";
import { ChevronRight, PadlockIcon, PlugIcon, PlusIcon, RepeatIcon } from "./kit/icons";
import { NOT_LIVE, type AgentCard, type AgentItem, type CardAction } from "@/lib/agents/list";
import { EQUITIES } from "@/lib/tokens/registry";
import { RetryButton } from "./kit/RetryButton";

/*
 * The Agents tab, an overview (Adrian, 2026-10-20: "the agent page is the entry page for all type of agents we have,
 * each one opens a dedicated sheet with all the info needed… if you want to see more or take action you need to open
 * the sheet"): one card per agent, the agents to come, and what they did and why. No warnings stacked on top and no
 * switches: Protect's card carries its own state, and every action lives in the agent's sheet. Plain values in, so the
 * dev gallery draws every state.
 */

export function AgentsView({
  protect,
  rebalance,
  live,
  signed,
  feed,
}: {
  /** Protect's card (ProtectCard). */
  protect: ReactNode;
  /** The Rebalancer's. */
  rebalance: ReactNode;
  /** Whether the agents can be switched on (AGENTS_LIVE): until then, Coming soon. */
  live: boolean;
  /**
   * Whether the Rebalancer's limit is signed: the foot says so once it is (ruling 16). Protect has no amount limit
   * (2026-10-19), so the limit the foot names is the Rebalancer's.
   */
  signed: boolean;
  feed: ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[calc(env(safe-area-inset-top)+8px)] leading-[normal]">
      <TabHeader title="Agents" back="/home" />
      <section aria-label="My agents" className="flex flex-col gap-3">
        {protect}
        {rebalance}
        {!live && <p className="m-0 px-1 text-xs leading-[1.4] text-subtle">{NOT_LIVE}</p>}
      </section>
      <section aria-label="Coming soon" className="flex flex-col gap-2">
        {PLANNED.map((p) => (
          <PlannedRow key={p.name} {...p} />
        ))}
      </section>
      {feed}
      <p className="m-0 flex items-center justify-center gap-1.5 text-xs text-subtle">
        <PadlockIcon />
        <span>
          {signed ? "Rebalance’s limit is signed with Face ID." : "You approve each agent with Face ID."} Enforced by{" "}
          <span className="font-bold text-ink">JAW.id</span>.
        </span>
      </p>
      <TabBar />
    </div>
  );
}

const TONE: Record<AgentCard["tone"], string> = {
  watch: "bg-watch-soft",
  act: "bg-neg-soft",
};

/**
 * A warning in Protect's sheet: one sentence, and Top up and Repay. Their sheets open once the sheet it sits in has
 * closed (`onLeave`), as every sheet hops to a money sheet.
 */
export function AttentionCard({ card, onLeave }: { card: AgentCard; onLeave?: () => void }) {
  const money = useMoneySheets();
  const button = (a: CardAction, i: number) => (
    <Button
      key={a.label}
      variant={i === 0 ? "dark" : "primary"}
      onClick={() => {
        onLeave?.();
        if (a.sheet === "top-up") money.topUp();
        else money.repay();
      }}
    >
      {a.label}
    </Button>
  );
  return (
    <section
      aria-label={`From ${card.agent}`}
      className={`flex flex-col gap-3 rounded-[22px] p-3.5 ${TONE[card.tone]}`}
    >
      <div className="flex items-center gap-2.5">
        <AgentMark agent={card.agent} size={32} />
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <p role="alert" className="m-0 text-[15px] font-semibold leading-[1.3]">
            {card.text}
          </p>
          {card.sub && <p className="m-0 text-[13px] leading-[1.35] text-ink-2">{card.sub}</p>}
        </div>
      </div>
      {card.actions.length > 0 && <div className="grid grid-cols-2 gap-2">{card.actions.map(button)}</div>}
    </section>
  );
}

/** Rebalance's mix, as a 4px bar in each stock's colour. */
export function MixBar({ mixBps }: { mixBps: readonly number[] }) {
  const set = EQUITIES.filter((e) => mixBps[e.reserveId] > 0).sort((a, b) => mixBps[b.reserveId] - mixBps[a.reserveId]);
  return (
    <span
      role="img"
      aria-label={`My mix: ${set.map((e) => `${e.name} ${mixBps[e.reserveId] / 100}%`).join(", ")}`}
      className="mt-1 flex h-1 w-full max-w-[160px] gap-px overflow-hidden rounded-[2px]"
    >
      {set.map((e) => (
        <span key={e.symbol} style={{ flex: mixBps[e.reserveId], background: stockColor(e.symbol) }} />
      ))}
    </span>
  );
}

/** Agents planned after Protect and Rebalance: on the tab as Coming soon, with nothing to open yet. */
const PLANNED = [
  { name: "DCA", does: "Buys stocks with your cash on a schedule", Icon: RepeatIcon },
  { name: "Auto top up", does: "Tops up your cash from another wallet every month", Icon: PlusIcon },
  { name: "JAW MCP", does: "Lets your AI assistant use your account, within limits you sign", Icon: PlugIcon },
] as const;

/** A planned agent's row: the agent row's card, its mark and name, what it will do, and Coming soon. */
function PlannedRow({ name, does, Icon }: (typeof PLANNED)[number]) {
  return (
    <div className="flex items-center gap-2.5 rounded-[22px] bg-card px-3 py-3 shadow-card-elev">
      <span aria-hidden className="flex size-[38px] shrink-0 items-center justify-center rounded-full bg-chip text-ink">
        <Icon />
      </span>
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-base font-semibold">{name}</span>
        <span className="text-[13px] leading-[1.35] text-subtle">{does}</span>
      </span>
      <ComingSoon />
    </div>
  );
}

/** In place of a switch or Save while the agents aren't live (rulings 19, 22). */
export function ComingSoon() {
  return (
    <span className="flex h-6 shrink-0 items-center whitespace-nowrap rounded-xl bg-pill px-2.5 text-xs font-semibold text-ink-mid">
      Coming soon
    </span>
  );
}

/**
 * One agent: its mark, name and what it does, its switch (Coming soon until the agents are live), then what it does
 * next and its limit (the Rebalancer's; Protect has none). The row opens the agent's sheet; the switch opens JAW's own
 * sheet for the grant (at the limit shown, or Protect's at the executor's CAP_MAX), or for the revoke.
 */
export function AgentRow({
  item,
  live,
  switchable,
  onOpen,
  onSwitch,
  extra,
}: {
  item: AgentItem;
  live: boolean;
  switchable: boolean;
  onOpen: () => void;
  onSwitch: (on: boolean) => void;
  /** Under what it does: Rebalance's mix bar. */
  extra?: ReactNode;
}) {
  return (
    <div className="relative rounded-[22px] bg-card shadow-card-elev">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${item.name}: ${item.line}. Open`}
        className="absolute inset-0 rounded-[22px]"
      />
      <div className="pointer-events-none relative flex items-center gap-2.5 px-3 pb-2.5 pt-3">
        <AgentMark agent={item.name} size={38} />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-base font-semibold">{item.name}</span>
          <span className="truncate text-[13px] text-subtle">{item.does}</span>
          {extra}
        </span>
        {live ? (
          <span className="pointer-events-auto">
            <Switch
              label={`${item.name} ${item.on ? "on" : "off"}`}
              checked={item.on}
              disabled={!switchable}
              onChange={onSwitch}
            />
          </span>
        ) : (
          <ComingSoon />
        )}
      </div>
      <div className="pointer-events-none relative flex items-center gap-2 border-t border-hairline py-2.5 pl-3 pr-2.5">
        <span className="num min-w-0 grow truncate text-[13px] text-ink-2">{item.line}</span>
        {item.limit && (
          <span className="num flex h-[22px] shrink-0 items-center rounded-[11px] bg-pill px-2 text-xs font-semibold text-ink-mid">
            {item.limit}
          </span>
        )}
        <ChevronRight size={16} className="shrink-0 text-subtle" />
      </div>
    </div>
  );
}

/** Which part of the feed couldn't be read: all of it, or only the agents' moves or the user's own. */
export type FeedError = "all" | "agents" | "yours" | null;

const NOTICE: Record<Exclude<FeedError, null>, string> = {
  all: "We couldn’t load your activity.",
  // The executor's rows: the agents' moves and the cash's own events (D20).
  agents: "We couldn’t load all of your activity.",
  yours: "We couldn’t load your own moves.",
};

/**
 * What they did, and why: the user's moves and the executor's, by day, with loading, empty and error states. Activity
 * draws it with no title of its own.
 */
export function AgentsFeed({
  title = "What they did, and why",
  empty,
  rows,
  nowMs,
  loading,
  error,
  onRetry,
  more,
  onShowEarlier,
}: {
  title?: string | null;
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
  const retry = <RetryButton onClick={onRetry} />;
  return (
    <section className="flex flex-col gap-1.5">
      {title && <h2 className="label m-0 px-1">{title}</h2>}
      <FeedCard>
        {loading ? (
          <div aria-busy className="flex flex-col gap-3 py-3.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-[16px] bg-chip" />
            ))}
          </div>
        ) : error === "all" ? (
          <div className="py-3.5">
            <p role="alert" className="m-0 mb-2.5 text-sm text-ink-2">
              {NOTICE.all}
            </p>
            {retry}
          </div>
        ) : (
          <>
            {error && (
              <div className="flex items-center justify-between gap-3 border-b border-hairline py-2.5">
                <p role="alert" className="m-0 text-[13px] leading-[1.35] text-ink-2">
                  {NOTICE[error]}
                </p>
                {retry}
              </div>
            )}
            {rows.length === 0 ? (
              <p className="m-0 py-3.5 text-sm leading-[1.4] text-ink-mid">{empty}</p>
            ) : (
              <FeedDays rows={rows} nowMs={nowMs} />
            )}
            {more && (
              <button
                type="button"
                onClick={onShowEarlier}
                className="flex h-11 w-full items-center justify-center border-t border-hairline text-[13px] font-semibold"
              >
                Show earlier
              </button>
            )}
          </>
        )}
      </FeedCard>
    </section>
  );
}

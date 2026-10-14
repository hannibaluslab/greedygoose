"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AgentMark, FeedCard, FeedDays, WordsText, type FeedRow } from "./Activity";
import { Button } from "./Button";
import { AgentPill } from "./Status";
import { TabBar } from "./TabBar";
import { ChevronRight, PadlockIcon } from "./icons";
import type { AgentItem } from "@/lib/agents/list";

/**
 * Design board "7 · Agents" (Agents.dc.html): what the agents did, and why. The heads-up sits on top while a sale is
 * pending; the agents' list, then the activity, then the Face ID footer.
 */
export function AgentsView({ headsUp, agents, reason, feed }: { headsUp: ReactNode; agents: AgentItem[]; reason: string | null; feed: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[54px] leading-[normal]">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">Agents</h1>
        <p className="m-0 text-sm leading-[1.4] text-ink-mid">What they did, and why.</p>
      </div>

      {headsUp}

      <div className="flex flex-col gap-2">
        {agents.map((a) => (
          <AgentCard key={a.agent} item={a} />
        ))}
        {reason && <p className="m-0 px-1 text-xs leading-[1.4] text-subtle">{reason}</p>}
      </div>

      {feed}

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

/** One agent on the list: its mark, its state, one line with its limit, and a chevron to where it's managed. */
export function AgentCard({ item }: { item: AgentItem }) {
  return (
    <Link
      href={item.href}
      aria-label={`${item.agent}, ${item.pill.text}. ${item.opens}`}
      className="flex items-center gap-2.5 rounded-[22px] bg-card px-3 py-2.5 text-ink no-underline shadow-card-elev"
    >
      <AgentMark agent={item.agent} size={38} />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex items-center justify-between gap-2">
          <span className="text-base font-semibold leading-[normal]">{item.agent}</span>
          <AgentPill tone={item.pill.tone}>{item.pill.text}</AgentPill>
        </span>
        <span className="truncate text-[13px] text-subtle">{item.sub}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-subtle" />
    </Link>
  );
}

/**
 * Protect · sell's heads-up (decision 3): "Add $X, or Protect sells $Y in 30 min", from the executor's event. The
 * sale goes ahead on its own if nothing changes, so both ways out are one tap away.
 */
export function HeadsUpCard({ add, sell, when, status }: { add: string; sell: string; when: string; status: "watch" | "act" }) {
  return (
    <section aria-label="Heads-up from Protection" className="flex flex-col gap-3 rounded-[22px] bg-watch-soft p-3.5">
      <div className="flex items-start gap-2.5">
        <AgentMark agent="Protection" size={32} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p role="alert" className="m-0 text-[15px] font-semibold leading-[1.3]">
            Add {add}, or Protect sells {sell} <span className="whitespace-nowrap">{when}</span>
          </p>
          <p className="m-0 text-[13px] leading-[1.35] text-ink-2">
            <WordsText words={["Your credit is in ", { status }, "."]} />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="dark" href="/receive">
          Add money
        </Button>
        <Button href="/repay">Repay</Button>
      </div>
    </section>
  );
}

/** Which part of the feed couldn't be read: all of it, or only the agents' moves or the user's own. */
export type FeedError = "all" | "agents" | "yours" | null;

const NOTICE: Record<Exclude<FeedError, null>, string> = {
  all: "We couldn’t load your activity.",
  agents: "We couldn’t load what your agents did.",
  yours: "We couldn’t load your own moves.",
};

/** The board's Activity: the user's moves and the agents', by day, with loading, empty and error states. */
export function AgentsFeed({
  rows, nowMs, loading, error, onRetry, more, onShowEarlier,
}: {
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
      <h2 className="label m-0 px-1">Activity</h2>
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
            {rows.length === 0 ? (
              <p className="m-0 py-3.5 text-sm leading-[1.4] text-ink-mid">
                Nothing yet. Your buys, credit and repayments show up here, and so will what your agents do.
              </p>
            ) : (
              <FeedDays rows={rows} nowMs={nowMs} />
            )}
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

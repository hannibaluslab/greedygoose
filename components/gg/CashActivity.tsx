"use client";

import Link from "next/link";
import { useState } from "react";
import { ActivityAvatar, AgentMark, FeedCard, FeedItem, dayLabel } from "./Activity";
import { StockAvatar } from "./StockAvatar";
import { ChevronRight } from "./icons";
import { useCashActivity, type CashFeedError } from "@/hooks/useCashActivity";
import { useNowSec } from "@/hooks/useNowSec";
import type { CashMark, CashRow } from "@/lib/cashActivity";
import { USDC } from "@/lib/tokens/registry";

const NOTICE: Record<Exclude<CashFeedError, null>, string> = {
  all: "We couldn’t load your activity.",
  some: "We couldn’t load all of your activity.",
};

export const CASH_EMPTY = "Nothing in the last 7 days. Money that comes in, becomes cash or goes out shows up here.";

/** The Cash sheet's activity, read while the sheet is open (the hook mounts inside the drawer's content). */
export function CashActivity({ account }: { account: `0x${string}` }) {
  const feed = useCashActivity(account);
  const nowSec = useNowSec();
  return <CashFeed rows={feed.rows} nowMs={nowSec * 1000} loading={feed.loading} error={feed.error} onRetry={feed.retry} />;
}

function Mark({ mark }: { mark: CashMark }) {
  if (mark.kind === "stock") return <StockAvatar symbol={mark.symbol} size={32} />;
  if (mark.kind === "agent") return <AgentMark agent={mark.agent} size={32} />;
  return <ActivityAvatar symbol={USDC.symbol} size={32} />;
}

/**
 * What moved the cash, newest first, by day as Activity groups it, with "See all" to Activity: AgentsFeed's loading,
 * error and empty states, plain values in so the dev gallery draws each.
 */
export function CashFeed({
  rows, nowMs, loading, error, onRetry,
}: { rows: readonly CashRow[]; nowMs: number; loading: boolean; error: CashFeedError; onRetry: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const retry = (
    <button type="button" onClick={onRetry} className="h-10 shrink-0 rounded-[20px] bg-chip px-4 text-sm font-semibold">
      Try again
    </button>
  );
  const days = rows.reduce<{ label: string; rows: CashRow[] }[]>((out, row) => {
    const label = dayLabel(row.time, nowMs);
    if (out.at(-1)?.label === label) out.at(-1)!.rows.push(row);
    else out.push({ label, rows: [row] });
    return out;
  }, []);

  return (
    <section aria-label="Cash activity" className="flex flex-col gap-1.5">
      <div className="flex h-[22px] items-center justify-between">
        <h3 className="label m-0 px-1">Activity</h3>
        <Link href="/activity" className="-my-[5px] -mr-1 flex h-8 items-center gap-0.5 px-1 text-[13px] font-medium text-ink-mid no-underline">
          See all <ChevronRight />
        </Link>
      </div>
      <FeedCard>
        {loading ? (
          <div aria-busy className="flex flex-col gap-3 py-3.5">
            <span className="sr-only">Loading activity</span>
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
              <div className={`flex items-center justify-between gap-3 py-2.5 ${rows.length ? "border-b border-hairline" : ""}`}>
                <p role="alert" className="m-0 text-[13px] leading-[1.35] text-ink-2">{NOTICE[error]}</p>
                {retry}
              </div>
            )}
            {/* With part of it unread, "nothing" isn't known: the notice stands alone. */}
            {rows.length === 0
              ? !error && <p className="m-0 py-3.5 text-sm leading-[1.4] text-ink-mid">{CASH_EMPTY}</p>
              : days.map((day, d) => (
                  <div key={day.label} className={d ? "border-t border-hairline pt-2.5" : "pt-2"}>
                    <h4 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-subtle">{day.label}</h4>
                    <ol className="m-0 list-none p-0">
                      {day.rows.map((row, i) => (
                        <FeedItem
                          key={row.key}
                          mark={<Mark mark={row.mark} />}
                          title={row.title}
                          time={row.time}
                          line={row.line}
                          details={row.details}
                          hash={row.hash}
                          status={row.pending ? "pending" : "done"}
                          last={i === day.rows.length - 1}
                          open={open === row.key}
                          onToggle={() => setOpen(open === row.key ? null : row.key)}
                        />
                      ))}
                    </ol>
                  </div>
                ))}
          </>
        )}
      </FeedCard>
    </section>
  );
}

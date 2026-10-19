"use client";

import { useState, type ReactNode } from "react";
import { StockAvatar } from "../StockAvatar";
import { AgentsIcon, ChevronDown, ChevronRight, RebalanceIcon, ShieldIcon } from "../icons";
import type { ActivityRow } from "@/hooks/useActivity";
import { useNames } from "@/hooks/useContacts";
import type { AgentRow } from "@/hooks/useAgentFeed";
import type { MoveBy, Words } from "@/lib/agents/feed";
import { describeActivity, moveLine, moveStatus } from "@/lib/activity/describe";
import { STATUS_LABEL } from "@/lib/risk/status";
import { txUrl } from "@/lib/chain";
import { USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { shortAddress } from "@/lib/formatting";

/** The round mark beside a move: the stock's badge, or a green $ for USDC and the other dollars that become cash. */
export function ActivityAvatar({ symbol, size }: { symbol: string; size: number }) {
  if (symbol !== USDC.symbol && !ENTRY_COINS.some((c) => c.symbol === symbol))
    return <StockAvatar symbol={symbol} size={size} />;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-safe font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.375 }}
    >
      $
    </span>
  );
}

/** Each agent's round mark: Protect's lime shield (the board's), the others' bone badges. */
const MARK: Record<Exclude<MoveBy, "Cash">, { Icon: typeof ShieldIcon; bg: string }> = {
  Protect: { Icon: ShieldIcon, bg: "bg-brand" },
  Rebalance: { Icon: RebalanceIcon, bg: "bg-card-bone" },
  Agents: { Icon: AgentsIcon, bg: "bg-card-bone" },
};

/**
 * 38px on the agent list (19px icon), 32px in the activity (16px icon), as the board draws them. A cash event wears
 * the green $ of a USDC move: no agent made it, as far as the user is concerned (D20).
 */
export function AgentMark({ agent, size }: { agent: MoveBy; size: 32 | 38 }) {
  if (agent === "Cash") return <ActivityAvatar symbol={USDC.symbol} size={size} />;
  const { Icon, bg } = MARK[agent];
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full text-ink ${bg}`}
      style={{ width: size, height: size }}
    >
      <Icon size={size === 38 ? 19 : 16} strokeWidth={size === 38 ? 1.9 : 2} />
    </span>
  );
}

const STATUS_TEXT = { safe: "text-pos", watch: "text-watch-ink", act: "text-neg" } as const;

/**
 * A feed line: Safe, Watch and Act in their colour and weight, as the board sets them. Geist has no "→", so the arrow
 * is set in the system font, as the board draws it (StatusChange does the same).
 */
function WordsText({ words }: { words: Words }) {
  return words.map((w, i) =>
    typeof w !== "string" ? (
      <span key={i} className={`font-semibold ${STATUS_TEXT[w.status]}`}>
        {STATUS_LABEL[w.status]}
      </span>
    ) : (
      w.split("→").map((part, j) => [
        j > 0 && (
          <span key={`${i}.${j}`} className="font-[system-ui]">
            →
          </span>
        ),
        part,
      ])
    ),
  );
}

/** The Agents board's Activity card. */
export function FeedCard({ children }: { children: ReactNode }) {
  return <div className="rounded-[22px] bg-card px-3.5 pb-0.5 shadow-card-elev">{children}</div>;
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** "Today", "Yesterday", a weekday within the week ("Tue"), then a date ("Oct 2"), as the board groups moves. */
export function dayLabel(ms: number, nowMs: number) {
  const days = Math.round((midnight(nowMs) - midnight(ms)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? WEEKDAY.format(ms) : DATE.format(ms);
}

/** A row of the feed: the user's own move (JAW's history), or the executor's (GooseExecutor's events). */
export type FeedRow = ActivityRow | AgentRow;
const isAgentRow = (r: FeedRow): r is AgentRow => "by" in r;

/** Moves grouped by day under the board's mono labels; one opens at a time for its details. */
export function FeedDays({ rows, nowMs }: { rows: readonly FeedRow[]; nowMs: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const days = rows.reduce<{ label: string; rows: FeedRow[] }[]>((out, row) => {
    const label = dayLabel(row.time, nowMs);
    if (out.at(-1)?.label === label) out.at(-1)!.rows.push(row);
    else out.push({ label, rows: [row] });
    return out;
  }, []);
  return days.map((day, d) => (
    <div key={day.label} className={d ? "border-t border-hairline pt-2.5" : "pt-2"}>
      <h3 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-subtle">{day.label}</h3>
      <ol className="m-0 list-none p-0">
        {day.rows.map((row, i) => {
          const props = {
            last: i === day.rows.length - 1,
            open: open === row.key,
            onToggle: () => setOpen(open === row.key ? null : row.key),
          };
          return isAgentRow(row) ? (
            <AgentMove key={row.key} row={row} {...props} />
          ) : (
            <Move key={row.key} row={row} {...props} />
          );
        })}
      </ol>
    </div>
  ));
}

/** One move, as the board draws an agent's: title · time, one line on what changed, details on tap. */
function Move({ row, last, open, onToggle }: { row: ActivityRow; last: boolean; open: boolean; onToggle: () => void }) {
  const main = row.items[0];
  // Who a send went to: the name this device sent it to, else the name the address has, else a short address.
  const sentTo = main?.kind === "send" && main.to ? main.to : null;
  const looked = useNames(sentTo && !main?.toName ? [sentTo] : []);
  const who = sentTo ? (main?.toName ?? looked.get(sentTo.toLowerCase()) ?? shortAddress(sentTo)) : undefined;
  const d = main ? describeActivity(main, who) : null;
  const line = moveLine(row, d);

  return (
    <li className={`py-2 ${last ? "" : "border-b border-hairline"}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 text-left"
      >
        <ActivityAvatar symbol={main?.symbol ?? "USDC"} size={32} />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-sm font-semibold leading-[1.3]">
            {d?.title ?? "Transaction"} <span className="font-normal text-subtle">· {TIME.format(row.time)}</span>
          </span>
          <span className={`num text-[13px] leading-[1.3] ${row.status === "failed" ? "text-act" : "text-ink-2"}`}>
            {line}
          </span>
        </span>
        <ChevronDown className={`mt-0.5 shrink-0 text-subtle ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <MoveDetails row={row} who={who} />}
    </li>
  );
}

/** A move's details on tap: each move in its batch, who a send went to, when, its status, and the transaction on Base. */
function MoveDetails({ row, who }: { row: ActivityRow; who: string | undefined }) {
  const main = row.items[0];
  const status = moveStatus(row.status);
  return (
    <div className="mt-2 rounded-[16px] bg-card-bone px-3 pt-2.5 text-[13px] leading-[1.35]">
      <dl className="num m-0 grid grid-cols-[82px_minmax(0,1fr)] gap-y-[5px]">
        {row.items.map((item, i) => {
          const x = describeActivity(item, i === 0 ? who : undefined);
          return (
            <Detail key={i} label={i === 0 ? "What" : ""}>
              {x.title}, {x.sign}
              {x.amount}
            </Detail>
          );
        })}
        {main?.kind === "send" && main.to && (
          <Detail label="To">
            {main.toName ? `${main.toName} · ${shortAddress(main.to)}` : shortAddress(main.to)}
          </Detail>
        )}
        <Detail label="When">{WHEN.format(row.time)}</Detail>
        {status && <Detail label="Status">{status}</Detail>}
      </dl>
      {row.hash ? (
        <a
          href={txUrl(row.hash)}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 flex h-10 items-center justify-between border-t border-hairline text-[13px] font-semibold text-ink no-underline"
        >
          View on Base <ChevronRight size={15} />
        </a>
      ) : (
        <div className="h-2.5" />
      )}
    </div>
  );
}

/**
 * One executor move: the agent (or "Cash" for a cash event) · time, what changed, and on tap why and the details, then
 * the transaction on Base.
 */
function AgentMove({
  row,
  last,
  open,
  onToggle,
}: {
  row: AgentRow;
  last: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`py-2 ${last ? "" : "border-b border-hairline"}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 text-left"
      >
        <AgentMark agent={row.by} size={32} />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-sm font-semibold leading-[1.3]">
            {row.by} <span className="font-normal text-subtle">· {TIME.format(row.time)}</span>
          </span>
          <span className="text-[13px] leading-[1.3] text-ink-2">
            <WordsText words={row.line} />
          </span>
        </span>
        <ChevronDown className={`mt-0.5 shrink-0 text-subtle ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 rounded-[16px] bg-card-bone px-3 pt-2.5 text-[13px] leading-[1.35]">
          {row.details.length > 0 && (
            <dl className="num m-0 mb-1.5 grid grid-cols-[82px_minmax(0,1fr)] gap-y-[5px]">
              {row.details.map((d) => (
                <Detail key={d.label} label={d.label} strong={d.label !== "Why"}>
                  <WordsText words={d.value} />
                </Detail>
              ))}
            </dl>
          )}
          <a
            href={txUrl(row.hash)}
            target="_blank"
            rel="noreferrer"
            className={`flex h-10 items-center justify-between text-[13px] font-semibold text-ink no-underline ${row.details.length ? "border-t border-hairline" : ""}`}
          >
            View on Base <ChevronRight size={15} />
          </a>
        </div>
      )}
    </li>
  );
}

/**
 * One feed line from plain parts, as Move and AgentMove draw theirs: its mark, title · time, one line on what changed,
 * and on tap the details (the 82px label column; "Why" in regular weight) and the transaction on Base. The Cash sheet
 * draws its rows with it.
 */
export function FeedItem({
  mark,
  title,
  time,
  line,
  details,
  hash,
  status = "done",
  last,
  open,
  onToggle,
}: {
  mark: ReactNode;
  title: string;
  /** When, in ms. */
  time: number;
  line: ReactNode;
  details: readonly { label: string; value: Words }[];
  hash?: `0x${string}`;
  status?: "pending" | "done" | "failed";
  last: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`py-2 ${last ? "" : "border-b border-hairline"}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 text-left"
      >
        {mark}
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-sm font-semibold leading-[1.3]">
            {title} <span className="font-normal text-subtle">· {TIME.format(time)}</span>
          </span>
          <span className={`num text-[13px] leading-[1.3] ${status === "failed" ? "text-act" : "text-ink-2"}`}>
            {line}
          </span>
        </span>
        <ChevronDown className={`mt-0.5 shrink-0 text-subtle ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 rounded-[16px] bg-card-bone px-3 pt-2.5 text-[13px] leading-[1.35]">
          {details.length > 0 && (
            <dl className={`num m-0 grid grid-cols-[82px_minmax(0,1fr)] gap-y-[5px] ${hash ? "mb-1.5" : ""}`}>
              {details.map((d, i) => (
                <Detail key={i} label={d.label} strong={d.label !== "Why"}>
                  <WordsText words={d.value} />
                </Detail>
              ))}
            </dl>
          )}
          {hash ? (
            <a
              href={txUrl(hash)}
              target="_blank"
              rel="noreferrer"
              className={`flex h-10 items-center justify-between text-[13px] font-semibold text-ink no-underline ${details.length ? "border-t border-hairline" : ""}`}
            >
              View on Base <ChevronRight size={15} />
            </a>
          ) : (
            <div className="h-2.5" />
          )}
        </div>
      )}
    </li>
  );
}

function Detail({ label, strong = true, children }: { label: string; strong?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-mid">{label}</dt>
      <dd className={`m-0 ${strong ? "font-semibold" : ""}`}>{children}</dd>
    </>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { ChevronDown, ChevronRight } from "./icons";
import type { ActivityRow } from "@/hooks/useActivity";
import type { ActivityItem } from "@/lib/activity/decode";
import { txUrl } from "@/lib/chain";
import { ALL_RESERVES, findByAddress } from "@/lib/tokens/registry";
import { formatShares, formatUsd } from "@/lib/formatting";

/** One decoded move in words: what happened, then its amount and sign. */
export function describeActivity(i: ActivityItem): { title: string; amount: string; sign: "+" | "−" | "" } {
  const r = ALL_RESERVES.find((x) => x.symbol === i.symbol) ?? findByAddress(i.symbol);
  const name = r?.kind === "equity" ? r.name : "USDC";
  const shares = `${formatShares(i.amount)} ${tickerOf(i.symbol)}`;
  switch (i.kind) {
    case "buy":
      return { title: `Bought ${name}`, amount: `${shares} · ${formatUsd(i.paidUsd ?? 0)}`, sign: "" };
    case "supply":
      return { title: `Backed credit with ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "" };
    case "withdraw":
      return { title: `Freed up ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "" };
    case "borrow":
      return { title: "Used credit", amount: formatUsd(i.amount), sign: "+" };
    case "repay":
      return { title: "Repaid credit", amount: formatUsd(i.amount), sign: "−" };
    case "receive":
      return { title: `Received ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "+" };
    case "send":
      return { title: `Sent ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "−" };
    case "save":
      return { title: "Moved into savings", amount: formatUsd(i.amount), sign: "" };
    case "unsave":
      return { title: "Moved out of savings", amount: formatUsd(i.amount), sign: "" };
  }
}

/** The round mark beside a move: the stock's badge, or a green $ for USDC. */
export function ActivityAvatar({ symbol, size }: { symbol: string; size: number }) {
  if (symbol !== "USDC") return <StockAvatar symbol={symbol} size={size} />;
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

/** Moves grouped by day under the board's mono labels; one opens at a time for its details. */
export function FeedDays({ rows, nowMs }: { rows: ActivityRow[]; nowMs: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const days = rows.reduce<{ label: string; rows: ActivityRow[] }[]>((out, row) => {
    const label = dayLabel(row.time, nowMs);
    if (out.at(-1)?.label === label) out.at(-1)!.rows.push(row);
    else out.push({ label, rows: [row] });
    return out;
  }, []);
  return days.map((day, d) => (
    <div key={day.label} className={d ? "border-t border-hairline pt-2.5" : "pt-2"}>
      <h3 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-subtle">{day.label}</h3>
      <ol className="m-0 list-none p-0">
        {day.rows.map((row, i) => (
          <Move
            key={row.key}
            row={row}
            last={i === day.rows.length - 1}
            open={open === row.key}
            onToggle={() => setOpen(open === row.key ? null : row.key)}
          />
        ))}
      </ol>
    </div>
  ));
}

/** One move, as the board draws an agent's: title · time, one line on what changed, details on tap. */
function Move({ row, last, open, onToggle }: { row: ActivityRow; last: boolean; open: boolean; onToggle: () => void }) {
  const main = row.items[0];
  const d = main ? describeActivity(main) : null;
  const status = row.status === "pending" ? "Confirming" : row.status === "failed" ? "Failed" : null;
  const line = [d && `${d.sign}${d.amount}`, row.items.length > 1 && `${row.items.length - 1} more`, status].filter(Boolean).join(" · ");

  return (
    <li className={`py-2 ${last ? "" : "border-b border-hairline"}`}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-start gap-2.5 text-left">
        <ActivityAvatar symbol={main?.symbol ?? "USDC"} size={32} />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-sm font-semibold leading-[1.3]">
            {d?.title ?? "Transaction"} <span className="font-normal text-subtle">· {TIME.format(row.time)}</span>
          </span>
          <span className={`num text-[13px] leading-[1.3] ${row.status === "failed" ? "text-act" : "text-ink-2"}`}>{line}</span>
        </span>
        <ChevronDown className={`mt-0.5 shrink-0 text-subtle ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 rounded-[16px] bg-card-bone px-3 pt-2.5 text-[13px] leading-[1.35]">
          <dl className="num m-0 grid grid-cols-[82px_minmax(0,1fr)] gap-y-[5px]">
            {row.items.map((item, i) => {
              const x = describeActivity(item);
              return (
                <Detail key={i} label={i === 0 ? "What" : ""}>
                  {x.title}, {x.sign}{x.amount}
                </Detail>
              );
            })}
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
      )}
    </li>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-mid">{label}</dt>
      <dd className="m-0 font-semibold">{children}</dd>
    </>
  );
}

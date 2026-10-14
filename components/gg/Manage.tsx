import Link from "next/link";
import type { ReactNode } from "react";
import { TabHeader, WhiteCard } from "./Screen";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { NETWORK_FEE_ROW } from "./Summary";
import { FaceIdButton, TxError } from "./TxUi";
import { ChevronRight, PlusIcon } from "./icons";
import type { TxPhase } from "@/hooks/useTx";
import { MIX_WHOLE } from "@/lib/agents/mix";
import { formatUsdTrim } from "@/lib/formatting";

/*
 * Manage's pieces, drawn as the boards draw them (Manage.dc.html, ManageCredit.dc.html). They take plain values, so the
 * dev gallery can show them with the boards' own figures.
 */

const TABS = [
  { key: "mix", label: "Your mix", href: "/manage" },
  { key: "credit", label: "Credit", href: "/manage/credit" },
] as const;

/**
 * The top of both tabs: back to Home, the board's title, "Set it once. It runs on its own." and the tabs. The boards'
 * third tab, "Every month" (ManageMonthly: Auto buy, Auto top up), is parked, so the control has two.
 */
export function ManageTop({ title, tab }: { title: string; tab: (typeof TABS)[number]["key"] }) {
  return (
    <div className="flex flex-col leading-[normal]">
      <TabHeader title={title} back="/home" menu={false} />
      <p className="m-0 mt-1 text-sm leading-[normal] text-ink-mid">Set it once. It runs on its own.</p>
      <div role="tablist" className="mt-2.5 grid h-10 shrink-0 grid-cols-2 rounded-[20px] bg-pill p-1">
        {TABS.map((t) =>
          t.key === tab ? (
            <span key={t.key} role="tab" aria-selected="true" className="flex items-center justify-center rounded-[16px] bg-card text-sm font-semibold shadow-[0_1px_3px_rgba(14,13,11,0.08)]">
              {t.label}
            </span>
          ) : (
            <Link key={t.key} href={t.href} role="tab" aria-selected="false" className="flex items-center justify-center text-sm font-medium text-ink-mid no-underline">
              {t.label}
            </Link>
          ),
        )}
      </div>
    </div>
  );
}

/** Until a tab's reads are in. */
export function ManageSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-2.5 px-5 pt-[54px]">
      <div className="h-[115px] animate-pulse rounded-[22px] bg-chip" />
      <div className="h-[300px] animate-pulse rounded-[22px] bg-chip" />
      <div className="h-[130px] animate-pulse rounded-[22px] bg-chip" />
    </div>
  );
}

/** A Manage card: white, 22px corners, the boards' 14px × 16px padding unless told otherwise. */
export function ManageCard({ className = "px-4 py-3.5 flex flex-col gap-2", children }: { className?: string; children: ReactNode }) {
  return <WhiteCard className={`leading-[normal] ${className}`}>{children}</WhiteCard>;
}

export function CardTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[17px] font-semibold">{title}</span>
      <span className="text-xs text-subtle">{sub}</span>
    </div>
  );
}

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12l5 5 9-10" />
  </svg>
);

/** One stock on the mix card, as Manage draws it. */
export type MixLine = { reserveId: number; symbol: string; name: string; bps: number; nowPct: number | null };

/** A target slider: the board's 4px track and 22px thumb, over an invisible native range for touch, keys, readers. */
export function MixSlider({ name, bps, onChange }: { name: string; bps: number; onChange: (bps: number) => void }) {
  const pct = bps / 100;
  return (
    <div className="group relative flex h-[22px] grow items-center">
      <div className="h-1 w-full rounded-[2px] bg-[rgba(15,14,11,0.08)]">
        <div className="h-1 rounded-[2px] bg-ink" style={{ width: `${pct}%` }} />
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute size-[22px] rounded-[11px] bg-card shadow-[0_0_0_1.5px_#0e0d0b,0_2px_6px_rgba(14,13,11,0.15)] group-has-[input:focus-visible]:outline-2 group-has-[input:focus-visible]:outline-offset-2 group-has-[input:focus-visible]:outline-ink"
        style={{ left: `calc(${pct}% - 11px)` }}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(pct)}
        onChange={(e) => onChange(Number(e.target.value) * 100)}
        aria-label={`${name} target`}
        aria-valuetext={`${Math.round(pct)}%`}
        className="gg-range absolute -left-[11px] m-0 h-full w-[calc(100%+22px)] cursor-pointer opacity-0 focus-visible:outline-none"
      />
    </div>
  );
}

/**
 * "Your mix" (Manage): a slider per stock, the share it holds now, the total, "Add a stock" and what the Rebalancer
 * would do (`happens`).
 */
export function MixCard({
  lines, onChange, onAdd, happens,
}: {
  lines: MixLine[];
  onChange: (reserveId: number, bps: number) => void;
  /** Opens the stocks not in the mix; left out when every stock is in it. */
  onAdd?: () => void;
  happens: ReactNode;
}) {
  const sum = lines.reduce((a, l) => a + l.bps, 0);
  const whole = sum === MIX_WHOLE;
  return (
    <ManageCard>
      <div className="flex items-start justify-between gap-3">
        <CardTitle title="Your mix" sub="Kept by the Rebalancer" />
        <span
          role="status"
          className={`flex h-6 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-xl px-2.5 text-xs font-semibold ${whole ? "bg-pos-soft text-pos" : "bg-watch-soft text-watch-text"}`}
        >
          {whole && <Check />}
          Adds up to {Math.round(sum / 100)}%
        </span>
      </div>
      {lines.map((l) => (
        <div key={l.reserveId} className="flex items-center gap-2.5">
          <StockAvatar symbol={l.symbol} size={30} font={tickerOf(l.symbol).length > 4 ? 7 : 8.5} />
          <div className="flex w-16 shrink-0 flex-col">
            <span className="whitespace-nowrap text-sm font-semibold">{l.name}</span>
            <span className="num text-[11px] text-subtle">{l.nowPct === null ? "none now" : `now ${l.nowPct}%`}</span>
          </div>
          <MixSlider name={l.name} bps={l.bps} onChange={(bps) => onChange(l.reserveId, bps)} />
          <span className="num w-[38px] shrink-0 text-right text-[15px] font-semibold">{Math.round(l.bps / 100)}%</span>
        </div>
      ))}
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[18px] border-[1.5px] border-dashed border-line-strong text-[13px] font-semibold text-ink"
        >
          <PlusIcon size={14} strokeWidth={2.2} />
          Add a stock
        </button>
      )}
      <div className="flex flex-col gap-1 rounded-[16px] bg-card-bone px-[13px] pb-3 pt-[11px]">
        <div className="flex items-center justify-between gap-3 whitespace-nowrap text-[13px]">
          <span className="font-semibold">What happens</span>
          <span className="text-ink-mid">
            {NETWORK_FEE_ROW.label} <b className="font-semibold text-ink">{NETWORK_FEE_ROW.value}</b>
          </span>
        </div>
        <p className="m-0 text-[13px] leading-[1.4] text-ink-2">{happens}</p>
      </div>
    </ManageCard>
  );
}

/**
 * A limit's chips (Manage "Its limit", ManageCredit "Can sell up to"), with "a week" or "a day" after them. The two
 * boards draw them at slightly different sizes.
 */
export function LimitChips({
  label, options, value, onChange, per, size,
}: { label: string; options: readonly number[]; value: number | null; onChange: (usd: number) => void; per: string; size: "sm" | "md" }) {
  const sm = size === "sm";
  return (
    <div role="radiogroup" aria-label={label} className={`num flex items-center ${sm ? "gap-1.5" : "gap-2"}`}>
      {options.map((usd) => (
        <button
          key={usd}
          type="button"
          role="radio"
          aria-checked={usd === value}
          onClick={() => onChange(usd)}
          className={`flex items-center text-sm ${sm ? "h-[34px] rounded-[17px] px-3.5" : "h-9 rounded-[18px] px-4"} ${usd === value ? "bg-ink font-semibold text-on-ink" : "bg-pill font-medium text-ink"}`}
        >
          {formatUsdTrim(usd)}
        </button>
      ))}
      <span className={`text-sm text-ink-mid ${sm ? "ml-1" : "ml-0.5"}`}>{per}</span>
    </div>
  );
}

/** A row that opens a choice (ManageCredit "Sells first"): the label, what's chosen, a chevron. */
export function ChoiceRow({ label, value, onClick, note }: { label: string; value: string; onClick: () => void; note?: string }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col gap-1 border-t border-hairline py-[13px] text-left text-ink">
      <span className="flex w-full items-center gap-3">
        <span className="grow text-[15px] font-semibold">{label}</span>
        <span className="flex items-center gap-1 whitespace-nowrap text-sm font-semibold">
          {value}
          <ChevronRight size={16} className="text-subtle" />
        </span>
      </span>
      {note && <span className="text-xs leading-[1.4] text-subtle">{note}</span>}
    </button>
  );
}

/** The foot of both tabs: "Save with Face ID", its error, and what saving does or why it can't. */
export function SaveFooter({
  phase, disabled, preview, onSave, error, note,
}: { phase: TxPhase; disabled: boolean; preview: boolean; onSave: () => void; error: string | null; note: string | null }) {
  return (
    <div className="mt-auto flex flex-col gap-2 pt-2">
      <TxError error={error} />
      <FaceIdButton label="Save with Face ID" phase={phase} disabled={disabled} preview={preview} onClick={onSave} />
      {note && <p className="m-0 text-center text-xs text-subtle">{note}</p>}
    </div>
  );
}

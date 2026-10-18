"use client";

import { useState } from "react";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { AssetPicker, type PickerRow } from "@/components/gg/AssetPicker";
import { LockIcon } from "@/components/gg/icons";
import { formatShares, formatUsdTrim } from "@/lib/formatting";
import { wholePct } from "@/lib/holding";
import type { planFreeUp } from "@/lib/freeUpPlan";

type Plan = ReturnType<typeof planFreeUp>;
type Row = Plan["rows"][number];

/** A stock in the list, as the sheet shows it: its name and what it holds (shares and dollars, all of them backing). */
export type FreeUpItem = { symbol: string; name: string; shares: number; usd: number };

/** The quick picks, as a share of the shares held; Max and All come from the limit. */
const PICKS = [0.5, 0.25] as const;

const sharesText = (share: number, held: number) => `${formatShares(share * held)}`;

/**
 * "Choose stocks to free up" (canvas boards 2–6): one row per stock that backs credit. Unticked, a row says what can
 * come out of it now, as a share of what it holds ("Free up All", "Up to 82%", "Limit reached", "Paused"); ticked, its
 * line says the shares that come out ("0.60 of 2.40 shares") and a chip shows how much in % (25%, 82%…), which opens
 * the list of picks. Custom takes a typed %. Over the rows, the free-up limit the ticked stocks use.
 */
export function FreeUpList({
  items,
  plan,
  disabled,
  onTick,
  onShare,
  onClose,
}: {
  items: FreeUpItem[];
  plan: Plan;
  disabled: boolean;
  onTick: (symbol: string, on: boolean, share: number) => void;
  onShare: (symbol: string, share: number) => void;
  /** "Not now": the list closes and nothing comes out. */
  onClose: () => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const picked = plan.rows.some((r) => r.picked);
  const used = wholePct(plan.used);
  return (
    <section className="flex flex-col gap-2" aria-label="Choose stocks to free up">
      <div className="flex items-center justify-between pl-1">
        <h2 className="m-0 text-[15px] font-semibold">Choose stocks to free up</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 items-center px-1 text-[13px] font-semibold text-ink-mid underline underline-offset-2"
        >
          Not now
        </button>
      </div>
      {picked && (
        <div
          role="meter"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Free-up limit: ${used}% used`}
          className="flex items-center gap-2.5 px-1"
        >
          <span className="whitespace-nowrap text-[12px] text-ink-mid">Free-up limit</span>
          <span className="flex h-1.5 grow rounded-[3px] bg-chip">
            <span className="rounded-[3px] bg-ink" style={{ width: `${used}%` }} />
          </span>
          <span className="num whitespace-nowrap text-[12px] font-semibold text-ink-2">{used}%</span>
        </div>
      )}
      {items.map((item) => {
        const row = plan.rows.find((r) => r.symbol === item.symbol)!;
        return (
          <StockRow
            key={item.symbol}
            item={item}
            row={row}
            disabled={disabled}
            menuOpen={menu === item.symbol}
            onMenu={(on) => setMenu(on ? item.symbol : null)}
            onTick={(on) => onTick(item.symbol, on, row.canAll ? 1 : row.maxShare)}
            onShare={(share) => {
              setMenu(null);
              onShare(item.symbol, share);
            }}
          />
        );
      })}
    </section>
  );
}

function StockRow({
  item,
  row,
  disabled,
  menuOpen,
  onMenu,
  onTick,
  onShare,
}: {
  item: FreeUpItem;
  row: Row;
  disabled: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onTick: (on: boolean) => void;
  onShare: (share: number) => void;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const blocked = row.paused || (!row.picked && row.maxShare <= 1e-9);
  const pct = wholePct(row.share);
  return (
    <div
      className={`flex flex-col gap-2 rounded-[16px] border-[1.5px] bg-card px-3 py-2 ${row.picked ? "border-ink" : "border-line-field"}`}
    >
      <div className="flex items-center gap-3">
        <label className={`relative flex min-h-11 min-w-0 grow items-center gap-3 ${blocked ? "" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            checked={row.picked}
            disabled={disabled || blocked}
            onChange={(e) => {
              setCustom(null);
              onTick(e.target.checked);
            }}
            className="peer absolute size-px opacity-0"
          />
          <span
            aria-hidden
            className={`flex size-6 shrink-0 items-center justify-center rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-ink ${
              row.picked
                ? "bg-ink"
                : blocked
                  ? "border-[1.5px] border-dashed border-line-strong"
                  : "border-[1.5px] border-ink-faint"
            }`}
          >
            {row.picked && (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth="3"
                strokeLinecap="round"
              >
                <path d="M5 12l5 5 9-10" />
              </svg>
            )}
          </span>
          <span className={blocked ? "opacity-45" : ""}>
            <StockAvatar symbol={item.symbol} size={36} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold">{item.name}</span>
            {row.picked ? (
              <span className="num truncate text-[12.5px] font-medium text-ink">
                {row.all
                  ? `${formatShares(item.shares)} shares`
                  : `${sharesText(row.share, item.shares)} of ${formatShares(item.shares)} shares`}
              </span>
            ) : (
              <span className="num truncate text-[12.5px] text-ink-mid">
                {formatShares(item.shares)} shares · {formatUsdTrim(Math.round(item.usd))}
              </span>
            )}
          </span>
        </label>
        {row.picked ? (
          <AssetPicker
            label={`${item.name} to free up: ${pct}%${row.all ? ", all of it" : ""}`}
            title="How much"
            name={`${pct}%`}
            mark={null}
            rows={shareRows(item, row)}
            selected={selectedId(row)}
            open={menuOpen}
            onToggle={() => onMenu(!menuOpen)}
            onClose={() => onMenu(false)}
            onPick={(id) => {
              onMenu(false);
              if (id === "custom") return setCustom("");
              setCustom(null);
              onShare(id === "all" ? 1 : id === "max" ? row.maxShare : Number(id));
            }}
            disabled={disabled}
          />
        ) : row.paused ? (
          <span className="shrink-0 text-[12.5px] text-ink-mid">Paused</span>
        ) : row.maxShare <= 1e-9 ? (
          <span className="shrink-0 text-[12.5px] text-ink-mid">Limit reached</span>
        ) : (
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="text-[11.5px] text-ink-mid">{row.canAll ? "Free up" : "Up to"}</span>
            <span className="num text-[14px] font-semibold">{row.canAll ? "All" : `${wholePct(row.maxShare)}%`}</span>
          </span>
        )}
      </div>
      {row.picked && custom !== null && (
        <form
          className="flex h-11 items-center gap-2 rounded-[12px] border-[1.5px] border-ink bg-card px-3"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(custom);
            if (n > 0) {
              // A typed % of what it holds, never past what the limit lets out.
              onShare(Math.min(n / 100, row.canAll ? 1 : row.maxShare));
              setCustom(null);
            }
          }}
        >
          <input
            autoFocus
            inputMode="numeric"
            aria-label={`Percent of ${item.name} to free up`}
            placeholder={`Up to ${row.canAll ? 100 : wholePct(row.maxShare)}`}
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/\D/g, "").slice(0, 3))}
            className="num min-w-0 grow bg-transparent text-[15px] font-semibold outline-none"
          />
          <span className="text-[13px] text-ink-mid">%</span>
          <button type="submit" className="h-8 rounded-[16px] bg-chip px-3 text-[13px] font-semibold">
            Set
          </button>
        </form>
      )}
    </div>
  );
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Which pick the chip stands on: All, Max, a quick pick, or a typed amount (Custom). */
function selectedId(row: Row): string {
  if (row.all) return "all";
  if (!row.canAll && near(row.share, row.maxShare)) return "max";
  const pick = PICKS.find((s) => near(row.share, s));
  return pick !== undefined ? String(pick) : "custom";
}

/**
 * The chip's list, in NYM's dropdown (AssetPicker): All, padlocked with the repay it still needs until it fits; Max, the
 * most the limit lets out, with its share; the quick picks under it; Custom, to type the shares.
 */
function shareRows(item: FreeUpItem, row: Row): PickerRow[] {
  const shares = (share: number) => `${sharesText(share, item.shares)} shares`;
  return [
    {
      id: "all",
      name: "All",
      mark: row.canAll ? null : <LockIcon size={13} />,
      sub: row.canAll ? undefined : `+${formatUsdTrim(row.allNeedsUsd)} repay`,
      right: shares(1),
      disabled: !row.canAll,
    },
    ...(row.canAll
      ? []
      : [{ id: "max", name: "Max", mark: null, sub: `${wholePct(row.maxShare)}%`, right: shares(row.maxShare) }]),
    ...PICKS.filter((s) => s < row.maxShare - 1e-9).map((s) => ({
      id: String(s),
      name: `${s * 100}%`,
      mark: null,
      right: shares(s),
    })),
    { id: "custom", name: "Custom", mark: null, sub: "Type a %" },
  ];
}

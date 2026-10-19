"use client";

import { useId } from "react";
import { AmountInput } from "@/components/gg/kit/AmountInput";
import { AssetPicker, assetMark, type PickerRow } from "@/components/gg/kit/AssetPicker";
import { StatusPill } from "@/components/gg/Status";
import type { PositionData } from "@/hooks/usePosition";
import { formatUsd } from "@/lib/formatting";
import { REPAY_COPY, statusAfter, type RepayAction, type RepaySource, type RepayView } from "@/lib/repay";

const markOf = (s: RepaySource, size: number) => assetMark(s.kind === "cash" ? "cash" : s.stock!.symbol, size);

/**
 * "Pay with | Repay" (canvas boards 1 and 8): what pays, as one picker (the cash, each stock held free, each stock that
 * backs credit, with the status the amount would land in), and what it repays, typed in dollars, with All in the field.
 * A stock that pays says the shares it sells and their price under the box.
 */
export function PayBox({
  data,
  sources,
  view,
  menuOpen,
  disabled,
  onMenu,
  onMenuClose,
  dispatch,
}: {
  data: PositionData;
  sources: RepaySource[];
  view: RepayView;
  menuOpen: boolean;
  disabled: boolean;
  onMenu: () => void;
  onMenuClose: (e: Event) => void;
  dispatch: (a: RepayAction) => void;
}) {
  const id = useId();
  const { source } = view;
  const rows: PickerRow[] = sources.map((s) => {
    const after = s.id === source.id ? view.after : statusAfter(s, view.amountUsd, data);
    return {
      id: s.id,
      name: s.name,
      mark: markOf(s, 32),
      sub: s.sub,
      aside: (
        <>
          <span className="sr-only">{REPAY_COPY.after}: </span>
          <StatusPill status={after} size="row" />
        </>
      ),
    };
  });
  const [have] = source.sub.split(" ");
  const each =
    source.kind !== "cash" && source.holding && view.sharesLine
      ? `${view.sharesLine} · ${formatUsd(source.holding.priceUsd)} each`
      : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 rounded-[16px] border border-line-field bg-card leading-[normal]">
        <div className="flex min-w-0 flex-col gap-1 border-r border-line-field px-3.5 py-3">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-mid">
            {REPAY_COPY.payWith}
          </span>
          <AssetPicker
            label={REPAY_COPY.payWithLabel(source.name, source.sub)}
            title={REPAY_COPY.payWith}
            titleAside={
              <span aria-hidden className="pr-[34px]">
                {REPAY_COPY.after}
              </span>
            }
            name={source.name}
            mark={markOf(source, 22)}
            rows={rows}
            selected={source.id}
            open={menuOpen}
            onToggle={onMenu}
            onClose={onMenuClose}
            onPick={(next) => {
              onMenu();
              if (next !== source.id) dispatch({ type: "source", id: next });
            }}
            disabled={disabled}
            footer={
              sources.some((s) => s.kind === "backing") ? (
                <p className="m-0 text-[12px] leading-snug text-subtle">{REPAY_COPY.safest}</p>
              ) : undefined
            }
            wide
            peek
            align="start"
            startInset={15}
          />
          <span className="num truncate text-[12px] text-ink-mid">{have}</span>
        </div>
        <label htmlFor={id} className="flex min-w-0 cursor-text flex-col gap-1 px-3.5 py-3">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-mid">Repay</span>
          <span className="num flex h-10 min-w-0 items-center gap-1.5 rounded-[12px] border-[1.5px] border-line-strong bg-ground pl-2.5 pr-1.5 font-semibold focus-within:border-ink focus-within:bg-card">
            <span aria-hidden className="text-[16px] text-ink-mid">
              $
            </span>
            <AmountInput
              id={id}
              value={view.fieldText}
              onValue={(value) => dispatch({ type: "amount", value, max: view.max })}
              disabled={disabled}
              className="min-w-0 grow text-[20px] leading-none tracking-[-0.02em]"
            />
            <button
              type="button"
              aria-label="Repay all"
              aria-pressed={view.all}
              disabled={disabled}
              onClick={() => dispatch({ type: "all" })}
              className={`flex h-7 shrink-0 items-center rounded-[14px] px-2.5 text-[12.5px] font-semibold ${view.all ? "bg-ink text-on-ink" : "bg-chip text-ink-2"}`}
            >
              All
            </button>
          </span>
        </label>
      </div>
      {each && <span className="num px-1 text-[12.5px] text-ink-mid">{each}</span>}
      {view.snapLine && (
        <p role="status" className="m-0 px-1 text-[13px] leading-snug text-ink-mid">
          {view.snapLine}
        </p>
      )}
    </div>
  );
}

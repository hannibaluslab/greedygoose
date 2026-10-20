"use client";

import { useId } from "react";
import { ManageCard } from "@/components/gg/Manage";
import { MoneyField } from "@/components/gg/kit/MoneyField";
import { Switch } from "@/components/gg/kit/Switch";
import {
  KEEP_LABEL,
  TOP_UPS_SUB,
  TOP_UPS_TITLE,
  keepText,
  parseKeepUsd,
  type TopUpsNote,
  type TopUpsView,
} from "@/lib/agents/topUps";

/**
 * "Top-ups go into my mix" in Rebalance's sheet (boards 7e–7h), view only: its switch, and while it's on, Keep as cash,
 * the line under it and at most one note (lib/agents/topUps.ts `topUpsView` picks them). `busy`: JAW's sheet is open
 * for this sheet's Save, so nothing changes under it.
 */
export function TopUpsCard({
  view,
  on,
  keepUsd,
  busy = false,
  onToggle,
  onKeep,
}: {
  view: TopUpsView;
  on: boolean;
  keepUsd: number | null;
  busy?: boolean;
  onToggle: (on: boolean) => void;
  onKeep: (usd: number | null) => void;
}) {
  const keepId = useId();
  return (
    <ManageCard>
      <div className="flex items-center gap-3">
        <div className="flex grow flex-col gap-0.5">
          <span className="text-[17px] font-semibold">{TOP_UPS_TITLE}</span>
          <span className="text-[13px] leading-[18px] text-ink-mid">{TOP_UPS_SUB}</span>
        </div>
        <Switch checked={on} onChange={onToggle} label={TOP_UPS_TITLE} disabled={view.disabled || busy} />
      </div>
      {view.blocked && <span className="text-[13px] leading-[18px] text-subtle">{view.blocked}</span>}
      {view.open && (
        <>
          <div aria-hidden className="my-1 h-px bg-hairline" />
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={keepId} className="text-[15px] font-medium">
              {KEEP_LABEL}
            </label>
            <MoneyField
              id={keepId}
              value={keepText(keepUsd)}
              onValue={(typed) => onKeep(parseKeepUsd(typed))}
              disabled={busy}
            />
          </div>
          {view.helper && <span className="text-[13px] leading-[18px] text-ink-mid">{view.helper}</span>}
          {view.note && <Note note={view.note} />}
        </>
      )}
    </ManageCard>
  );
}

/** The one note under Keep: bone while turning on or a top-up waits, amber for the warning (board 7h). */
function Note({ note }: { note: TopUpsNote }) {
  if (note.kind !== "warning")
    return (
      <div role="status" className="mt-1 flex flex-col gap-0.5 rounded-[16px] bg-card-bone px-[13px] pb-3 pt-[11px]">
        <span className="text-sm font-semibold">{note.title}</span>
        <span className="text-[13px] leading-[18px] text-ink-2">{note.line}</span>
      </div>
    );
  return (
    <div role="note" className="mt-1 flex items-start gap-2.5 rounded-[16px] bg-due-soft px-[13px] pb-3 pt-[11px]">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="mt-px shrink-0 text-due-ink"
      >
        <path d="M12 4l9 16H3z" />
        <path d="M12 10v4M12 17h.01" />
      </svg>
      <div className="flex flex-col gap-0.5 text-due-ink">
        <span className="text-sm font-semibold">{note.title}</span>
        <span className="text-[13px] leading-[18px]">{note.line}</span>
      </div>
    </div>
  );
}

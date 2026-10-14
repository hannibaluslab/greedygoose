import type { ReactNode } from "react";
import { WhiteCard } from "./Screen";
import { FaceIdButton, TxError } from "./TxUi";
import type { TxPhase } from "@/hooks/useTx";

/*
 * The settings bodies' shared pieces (Protect's and Rebalance's, in their agent sheets), drawn as the Manage boards
 * drew them. Manage itself is gone: its two tabs became those bodies.
 */

/** A settings card: white, 22px corners, the boards' 14px × 16px padding unless told otherwise. */
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

/** The foot of a settings body: its Face ID button, its error, and what saving does or why it can't. */
export function SaveFooter({
  phase, disabled, preview, onSave, error, note, label = "Save with Face ID",
}: {
  phase: TxPhase;
  disabled: boolean;
  preview: boolean;
  onSave: () => void;
  error: string | null;
  note: string | null;
  /** What the button does: "Save with Face ID", or "Switch on with Face ID" while the agent is off. */
  label?: string;
}) {
  return (
    <div className="mt-auto flex flex-col gap-2 pt-2">
      <TxError error={error} />
      <FaceIdButton label={label} phase={phase} disabled={disabled} preview={preview} onClick={onSave} />
      {note && <p className="m-0 text-center text-xs text-subtle">{note}</p>}
    </div>
  );
}

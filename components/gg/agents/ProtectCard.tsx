"use client";

import type { CSSProperties } from "react";
import { AgentMark } from "../activity/Activity";
import { ChevronRight } from "../kit/icons";
import { BAR, barPosition } from "../Status";
import { RISK } from "@/config/risk";
import { protectCardLabel, type PillTone, type ProtectCardModel } from "@/lib/agents/protectCard";

/*
 * Protect's card on the Agents overview, as validated on the boards (7, 7a–7d; the levels bar is option A of 7k): the
 * whole card is one button that opens Protect's sheet. Plain values in, so the dev gallery draws every state.
 */

const PILL: Record<PillTone, string> = {
  on: "bg-pos-soft text-pos",
  neutral: "bg-card-bone text-ink-mid",
  act: "bg-neg-soft text-neg",
  needs: "bg-[#f8d9bf] text-[#7a360a]",
  watch: "bg-watch-soft text-watch-ink",
  working: "bg-brand text-ink",
};

const WORD: Record<"Safe" | "Watch" | "Act", string> = { Safe: "text-pos", Watch: "text-watch-ink", Act: "text-neg" };

export function ProtectCardView({ model, onOpen }: { model: ProtectCardModel; onOpen?: () => void }) {
  const inAct = model.word === "Act";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={protectCardLabel(model)}
      className="flex w-full flex-col rounded-[22px] bg-card p-[18px] text-left text-ink shadow-[0_1px_2px_rgba(14,13,11,0.04),0_6px_20px_rgba(14,13,11,0.06)] transition-transform active:scale-[0.98]"
    >
      <span className="flex h-8 items-center gap-2.5">
        <AgentMark agent="Protector" size={32} />
        <span className="grow text-[17px] font-semibold">Protector</span>
        <span
          className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded-xl px-2.5 text-xs font-bold ${PILL[model.pill.tone]}`}
        >
          {model.pill.text}
        </span>
        <ChevronRight size={14} className="shrink-0 text-ink-mid" />
      </span>
      <span className="mt-4 text-[13px] font-medium leading-[18px] text-ink-mid">Your credit health</span>
      {model.hf === null ? (
        <span className="mt-0.5 text-[28px] font-semibold leading-[44px] tracking-[-0.02em] text-ink-mid">
          No credit
        </span>
      ) : (
        <span className="mt-0.5 flex items-baseline gap-2">
          <span
            className={`num text-[40px] font-semibold leading-[44px] tracking-[-0.02em] ${inAct ? "text-neg" : "text-ink"}`}
          >
            {model.hf.toFixed(2)}
          </span>
          {model.word && <span className={`text-[17px] font-semibold ${WORD[model.word]}`}>{model.word}</span>}
        </span>
      )}
      <LevelBar bar={model.bar} />
      <span className="mt-3.5 text-[15px] font-medium leading-5">{model.line1}</span>
      {model.line2 && <span className="mt-1 text-sm leading-[19px] text-ink-mid">{model.line2}</span>}
    </button>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const MONO = "font-mono text-[10px] font-medium leading-3 whitespace-nowrap";
/** Where Safe ends and Watch begins along the bar: Watch's caption starts there. */
const SAFE_END = barPosition(RISK.safeMin);
/** Where Watch ends and Act begins: Act's caption starts there, as Watch's starts at SAFE_END. */
const WATCH_END = barPosition(RISK.watchMin);

/** A mark across the bar: solid while Protect guards it, dashed while nothing does. */
function Tick({ at, solid }: { at: number; solid: boolean }) {
  const style: CSSProperties = {
    left: `calc(${pct(at)} - 1px)`,
    background: solid ? undefined : "repeating-linear-gradient(to bottom, var(--ink-mid) 0 2px, transparent 2px 4px)",
  };
  return <span aria-hidden className={`absolute top-3.5 h-[18px] w-0.5 ${solid ? "bg-ink" : ""}`} style={style} />;
}

/**
 * Option A of board 7k: the app's Safe, Watch and Act bar, under each colour its name and where it starts, and
 * Protect's line marked over it. A rescue shows its path back to the target; a weekend risk, the drop that would reach
 * Aave's line (the bar's end).
 */
export function LevelBar({ bar }: { bar: ProtectCardModel["bar"] }) {
  const at = bar.hf === null ? null : barPosition(bar.hf);
  const line = barPosition(bar.line);
  const target = barPosition(bar.target);
  const fmt = (x: number) => x.toFixed(2);
  const label = `Your credit health on the scale: Safe from ${fmt(RISK.safeMin)}, Watch from ${fmt(RISK.watchMin)} to ${fmt(RISK.safeMin)}, Act under ${fmt(RISK.watchMin)}. Protector steps in under ${fmt(bar.line)}.`;
  return (
    <div role="img" aria-label={label} className="relative mt-4 h-[72px]">
      {bar.working ? (
        <>
          <span
            className={`absolute top-0 w-7 text-center text-ink ${MONO}`}
            style={{ left: `calc(${pct(target)} - 14px)` }}
          >
            {fmt(bar.target)}
          </span>
          <span
            className={`absolute top-0 w-7 text-center text-ink ${MONO}`}
            style={{ left: `calc(${pct(line)} - 14px)` }}
          >
            {fmt(bar.line)}
          </span>
        </>
      ) : bar.dropPct !== null ? (
        <span className={`absolute right-0 top-0 text-ink ${MONO}`}>If stocks fall {bar.dropPct}%</span>
      ) : (
        <span className={`absolute right-0 top-0 ${bar.guarded ? "text-ink" : "text-ink-mid"} ${MONO}`}>
          Protector · {fmt(bar.line)}
        </span>
      )}
      <span aria-hidden className="absolute inset-x-0 top-[18px] flex h-2.5 gap-[3px]">
        <span className="rounded-[5px] bg-pos" style={{ flex: BAR.safe }} />
        <span className="rounded-[5px] bg-watch" style={{ flex: BAR.watch }} />
        <span className="rounded-[5px] bg-neg" style={{ flex: BAR.act }} />
        <span className="rounded-[5px] bg-act-edge" style={{ flex: BAR.edge }} />
      </span>
      <Tick at={line} solid={bar.guarded} />
      {bar.working && at !== null && (
        <>
          <Tick at={target} solid />
          <span
            aria-hidden
            className="absolute top-3 border-t-2 border-dotted border-ink"
            style={{ left: `calc(${pct(target)} + 6px)`, width: `calc(${pct(at - target)} - 14px)` }}
          />
          <span
            aria-hidden
            className="absolute top-[9px] h-0 w-0 border-y-4 border-r-[6px] border-y-transparent border-r-ink"
            style={{ left: `calc(${pct(target)} + 1px)` }}
          />
        </>
      )}
      {bar.dropPct !== null && at !== null && (
        <>
          <span
            aria-hidden
            className="absolute top-3 border-t-2 border-dashed border-ink"
            style={{ left: `calc(${pct(at)} + 10px)`, width: `calc(${pct(1 - at)} - 20px)` }}
          />
          <span
            aria-hidden
            className="absolute top-3.5 box-border size-[18px] rounded-full border-2 border-dashed border-ink bg-card"
            style={{ left: "calc(100% - 9px)" }}
          />
        </>
      )}
      {at !== null && (
        <span
          aria-hidden
          className={`absolute top-3.5 box-border size-[18px] rounded-full ${
            bar.working
              ? "border-2 border-ink bg-brand"
              : "border-[3px] border-card bg-ink shadow-[0_2px_6px_rgba(14,13,11,0.25)]"
          }`}
          style={{ left: `calc(${pct(at)} - 9px)` }}
        />
      )}
      <span className="absolute left-0 top-[38px] flex flex-col" style={{ width: `calc(${pct(SAFE_END)} - 3px)` }}>
        <Caption name="Safe" range={`${fmt(RISK.safeMin)} and up`} tone="text-pos" />
      </span>
      <span className="absolute top-[38px] flex flex-col" style={{ left: `calc(${pct(SAFE_END)} + 3px)` }}>
        <Caption name="Watch" range={`${fmt(RISK.watchMin)} – ${fmt(RISK.safeMin)}`} tone="text-watch-ink" />
      </span>
      <span className="absolute top-[38px] flex flex-col" style={{ left: `calc(${pct(WATCH_END)} + 3px)` }}>
        <Caption name="Act" range={`under ${fmt(RISK.watchMin)}`} tone="text-neg" />
      </span>
    </div>
  );
}

function Caption({ name, range, tone }: { name: string; range: string; tone: string }) {
  return (
    <>
      <span className={`text-xs font-semibold leading-4 ${tone}`}>{name}</span>
      <span className="num whitespace-nowrap text-[11px] leading-[15px] text-ink-mid">{range}</span>
    </>
  );
}

/**
 * Protect's card while the registry or the position loads: its frame, nothing that could read as a value. It still
 * opens Protect's sheet, so turning it off never waits on a read.
 */
export function ProtectCardSkeleton({ onOpen }: { onOpen?: () => void }) {
  return (
    <button
      type="button"
      aria-busy
      aria-label="Protector. Open"
      onClick={onOpen}
      className="flex w-full flex-col gap-4 rounded-[22px] bg-card p-[18px] text-left shadow-[0_1px_2px_rgba(14,13,11,0.04),0_6px_20px_rgba(14,13,11,0.06)]"
    >
      <span className="flex h-8 items-center gap-2.5">
        <AgentMark agent="Protector" size={32} />
        <span className="grow text-[17px] font-semibold">Protector</span>
        <span className="h-6 w-14 animate-pulse rounded-xl bg-card-bone" />
      </span>
      <span className="h-9 w-24 animate-pulse rounded-lg bg-card-bone" />
      <span className="h-2.5 w-full animate-pulse rounded-[5px] bg-card-bone" />
      <span className="h-4 w-3/4 animate-pulse rounded bg-card-bone" />
    </button>
  );
}

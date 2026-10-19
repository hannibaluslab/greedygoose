"use client";

import { StockAvatar } from "@/components/gg/StockAvatar";
import { Switch } from "@/components/gg/Switch";
import type { ProtectChoice } from "@/lib/agents/protect";
import { formatUsdShort } from "@/lib/formatting";
import type { EQUITIES } from "@/lib/tokens/registry";

/* Protect · settings' parts: the choices under selling, the notes, and what Save does. */

/** "Sells first": GooseExecutor's `keepMix` for Protect · sell. */
export const ORDER = [
  {
    keepMix: false,
    label: "Most safety per dollar",
    sub: "Sells the least it takes to bring your credit back to Watch.",
  },
  { keepMix: true, label: "Keep my mix", sub: "Sells the same share of each stock that backs your credit." },
] as const;

const NEVER_SELL_WARNING = "Protect won’t sell it, but Aave still can if your credit goes past its limit.";

/**
 * Whether Save can go, and the line under it when it can't: not live yet, no network fee, or why the plan is blocked.
 * `ready`: the limit is a number, it's not the dev preview, nothing else is loading or signing, and the cap is read.
 */
export function saveState(p: {
  live: boolean;
  ready: boolean;
  feeBlocked: boolean;
  blocked: string | null;
  changes: number;
}) {
  const canSave = p.live && p.ready && !p.feeBlocked && !p.blocked && p.changes > 0;
  const note = !p.live
    ? "Not live yet"
    : p.feeBlocked
      ? "Your account can’t pay network fees from your cash right now."
      : p.blocked;
  return { canSave, note };
}

/** With selling on: which stock sells first, and the stocks never to sell (what backs the credit, and any listed). */
export function SellChoices({
  keepMix,
  onKeepMix,
  never,
  onNever,
  listedStocks,
  backsUsd,
}: {
  keepMix: ProtectChoice["keepMix"];
  onKeepMix: (keepMix: ProtectChoice["keepMix"]) => void;
  never: ProtectChoice["never"];
  onNever: (reserveId: number, on: boolean) => void;
  listedStocks: typeof EQUITIES;
  backsUsd: readonly number[];
}) {
  return (
    <>
      <div className="flex flex-col gap-2 border-t border-hairline py-[13px]">
        <span className="text-[15px] font-semibold">Sells first</span>
        <div role="radiogroup" aria-label="Sells first" className="flex flex-col">
          {ORDER.map((o) => {
            const on = o.keepMix === keepMix;
            return (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onKeepMix(o.keepMix)}
                className="flex min-h-11 w-full items-center gap-3 py-1.5 text-left text-ink"
              >
                <span
                  aria-hidden
                  className={`flex size-[22px] shrink-0 items-center justify-center rounded-full ${on ? "bg-ink text-on-ink" : "border-[1.5px] border-line-strong"}`}
                >
                  {on && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12l5 5 9-10" />
                    </svg>
                  )}
                </span>
                <span className="flex grow flex-col gap-[3px]">
                  <span className="text-sm font-semibold">{o.label}</span>
                  <span className="text-xs leading-[1.35] text-ink-mid">{o.sub}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-hairline py-[13px]">
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold">Never sell</span>
          <span className="text-xs leading-[1.4] text-subtle">{NEVER_SELL_WARNING}</span>
        </div>
        {listedStocks.length === 0 ? (
          <p className="m-0 text-sm text-ink-mid">None of your stocks back your credit.</p>
        ) : (
          listedStocks.map((e) => (
            <div key={e.symbol} className="flex items-center gap-3 py-1">
              <StockAvatar symbol={e.symbol} size={30} />
              <span className="flex grow flex-col gap-[3px]">
                <span className="text-sm font-semibold">{e.name}</span>
                <span className="num text-xs text-subtle">
                  {backsUsd[e.reserveId] > 0 ? `Backs ${formatUsdShort(backsUsd[e.reserveId])}` : "Backs nothing now"}
                </span>
              </span>
              <Switch
                label={`Never sell ${e.name}`}
                checked={never.includes(e.reserveId)}
                onChange={(on) => onNever(e.reserveId, on)}
              />
            </div>
          ))
        )}
      </div>
    </>
  );
}

/** Under the daily limit: the test cap's note, and that Protect is off and starts on this limit. */
export function LimitNotes({ capNote, offNow }: { capNote: string | null; offNow: boolean }) {
  return (
    <>
      {capNote && <span className="text-xs leading-[1.4] text-subtle">{capNote}</span>}
      {offNow && (
        <span className="text-xs leading-[1.4] text-subtle">
          Off now. It starts on this limit when you switch it on.
        </span>
      )}
    </>
  );
}

/** What Save (or Switch on) does, one line per change; nothing with no change. */
export function SaveSummary({ off, lines }: { off: boolean; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[16px] bg-card-bone px-[13px] pb-3 pt-[11px] text-[13px]">
      <span className="font-semibold">{off ? "Switching on does" : "Saving does"}</span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-ink-2">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

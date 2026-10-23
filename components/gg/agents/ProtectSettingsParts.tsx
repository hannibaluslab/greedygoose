"use client";

import { useState } from "react";
import { AssetPicker, type PickerRow } from "@/components/gg/kit/AssetPicker";
import { useSheetMenu } from "@/components/gg/kit/SheetMenu";
import { StockAvatar } from "@/components/gg/kit/StockAvatar";
import { Switch } from "@/components/gg/kit/Switch";
import { backToText, lineOptions, lineText, targetOptions, type ProtectNumbers } from "@/lib/agents/lines";
import type { ProtectChoice } from "@/lib/agents/protect";
import { formatUsdShort } from "@/lib/formatting";
import { fallTo } from "@/lib/risk/health";
import type { EQUITIES } from "@/lib/tokens/registry";

/* Protect · settings' parts: its line and target, the choices under selling, the notes, and what Save does. */

/** Under a line in its list: how far the stocks can fall before Protector steps in there, rounded down. */
function fallText(hf: number, line: number) {
  const fall = fallTo(hf, line / 1e4);
  if (fall <= 0) return "Steps in now";
  return fall < 0.01 ? "If your stocks fall under 1%" : `If your stocks fall ${Math.floor(fall * 100)}%`;
}

/**
 * Where Protector steps in and what it brings the credit back to (GooseGuard's `setProtect`, decision 3): two NYM
 * pickers, the line from 1.03 and the target from 0.05 above it up to 1.40 (lib/agents/lines.ts). With credit, each
 * line says how far the stocks can fall before Protector steps in there.
 */
export function ProtectLines({
  line,
  target,
  saved,
  hf,
  onLine,
  onTarget,
  disabled,
}: {
  line: number;
  target: number;
  /** The saved line and target, kept on the lists when they're off them (set outside the app). */
  saved: { line: number; target: number };
  /** The credit's health now; null with no credit. */
  hf: number | null;
  onLine: (line: number) => void;
  onTarget: (target: number) => void;
  disabled: boolean;
}) {
  // Inside the agent sheet its menu guard holds which list is open (Escape closes the list first); alone, its own.
  const sheet = useSheetMenu();
  const [own, setOwn] = useState<string | null>(null);
  const open = sheet ? sheet.menu : own;
  const setOpen = sheet ? sheet.setMenu : setOwn;
  const close = (e: Event) => (sheet ? sheet.closeMenu(e) : setOwn(null));
  const lineRows: PickerRow[] = lineOptions(line, saved.line).map((v) => ({
    id: String(v),
    name: lineText(v),
    mark: null,
    ...(hf !== null && { sub: fallText(hf, v) }),
  }));
  const targetRows: PickerRow[] = targetOptions(line, target, saved.target).map((v) => ({
    id: String(v),
    name: lineText(v),
    mark: null,
  }));
  const row = (key: "line" | "target", label: string, value: number, rows: PickerRow[], pick: (v: number) => void) => (
    <div
      className={`flex items-center justify-between gap-3 py-[13px] ${key === "target" ? "border-t border-hairline" : ""}`}
    >
      <span className="text-[15px] font-semibold">{label}</span>
      <AssetPicker
        label={`${label}: ${lineText(value)}`}
        title={label}
        name={lineText(value)}
        mark={null}
        rows={rows}
        selected={String(value)}
        open={open === key}
        onToggle={() => setOpen(open === key ? null : key)}
        onClose={close}
        onPick={(id) => {
          setOpen(null);
          pick(Number(id));
        }}
        disabled={disabled}
      />
    </div>
  );
  return (
    <>
      {row("line", "Steps in under", line, lineRows, onLine)}
      {row("target", "Brings it back to", target, targetRows, onTarget)}
    </>
  );
}

/** "Sells first": GooseGuard's `keepMix` for Protect · sell. `sub` names where Protector brings the credit back to. */
export const ORDER = [
  {
    keepMix: false,
    label: "Most safety per dollar",
    sub: (n: ProtectNumbers) => `Sells the least it takes to bring your credit back to ${backToText(n)}.`,
  },
  { keepMix: true, label: "Keep my mix", sub: () => "Sells the same share of each stock that backs your credit." },
] as const;

const NEVER_SELL_WARNING = "Protector won’t sell it, but Aave still can if your credit goes past its limit.";

/**
 * Whether Save can go, and the line under it when it can't: not live yet, no network fee, or why the plan is blocked.
 * `ready`: it's not the dev preview, and nothing else is loading or signing.
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
  lines,
}: {
  /** Protector's line and target, in the Guard's units (lib/agents/lines.ts). */
  lines: { line: number; target: number };
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
                  <span className="text-xs leading-[1.35] text-ink-mid">
                    {o.sub({ line: lines.line / 1e4, target: lines.target / 1e4 })}
                  </span>
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

/** What Save (or Switch on) does, one line per change; nothing with no change. */
/**
 * What saving does, line by line, and, when the save's one Face ID lets Protect act (`allows`), what it lets it do:
 * JAW's batch sheet shows no words of ours, so this card says it before the tap (Adrian, 2026-10-20).
 */
export function SaveSummary({ off, lines, allows }: { off: boolean; lines: string[]; allows?: string | null }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[16px] bg-card-bone px-[13px] pb-3 pt-[11px] text-[13px]">
      <span className="font-semibold">{off ? "Switching on does" : "Saving does"}</span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-ink-2">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {allows && <p className="m-0 border-t border-hairline pt-2 leading-[1.4] text-ink-2">{allows}</p>}
    </div>
  );
}

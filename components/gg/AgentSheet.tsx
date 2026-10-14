"use client";

import type { ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { LimitChips } from "./LimitChips";
import { AgentPill } from "./Status";
import { NETWORK_FEE_ROW } from "./Summary";
import { TxButton, TxError } from "./TxUi";
import { ShieldIcon } from "./icons";
import { AGENT_COPY, type AgentItem, type SheetAction } from "@/lib/agents/list";
import type { AgentStatus } from "@/lib/agents/status";
import { stepsNote } from "@/lib/formatting";

/*
 * An agent's sheet (Adrian, 2026-10-15): what it does and never does, its state and next move, its limit, its own
 * settings, when it stops, what it did, and a way to switch it on or off. The sheet already says what a change does,
 * so there is no confirm step of ours: Switch on, Renew and Turn off open JAW's own sheet straight away, once a grant
 * or revoke (a small line says "2 steps" when there are more).
 */

export type LimitView = {
  options: readonly number[];
  /** What's on screen: the one picked, else the one it runs with. */
  value: number;
  per: "day" | "week";
  onChange: (usd: number) => void;
  /** The pick differs from what it runs with, so saving it is a new grant. */
  changed: boolean;
};

const PILL: Record<AgentStatus, { text: string; tone: "on" | "neutral" }> = {
  unconfigured: { text: "Not live yet", tone: "neutral" },
  loading: { text: "…", tone: "neutral" },
  off: { text: "Off", tone: "neutral" },
  starting: { text: "Starting", tone: "neutral" },
  on: { text: "On", tone: "on" },
};

const Label = ({ children }: { children: ReactNode }) => <h3 className="label m-0 px-1">{children}</h3>;

export function AgentSheet({
  open, onClose, item, live, busy, error, preview, offSteps, stops, limit, settings, settingsSave = false, activity, onAction,
}: {
  open: boolean;
  onClose: () => void;
  item: AgentItem;
  live: boolean;
  /** JAW's sheet is open for one of this sheet's changes: its buttons wait. */
  busy: boolean;
  /** What went wrong with the last change, if it didn't go through. */
  error: string | null;
  /** The dev preview (`?as=`): nothing can be signed. */
  preview: boolean;
  /** How many times turning it off opens JAW's sheet: once for each grant JAW lists. */
  offSteps: number;
  /** "Oct 15, 2027": when its grant ends, while it has one. */
  stops: string | null;
  /** The limits it offers; without them the sheet shows the one it runs with. */
  limit?: LimitView;
  /** Its own settings: Receive's coins, Protect's and Rebalance's settings bodies. */
  settings?: ReactNode;
  /**
   * The settings carry the limit and their own Save, which also switches the agent on (Protect, Rebalance): the sheet
   * then shows no limit of its own and no Switch on, so there is one limit and one button to JAW's sheet on screen.
   */
  settingsSave?: boolean;
  activity: ReactNode;
  onAction: (a: SheetAction) => void;
}) {
  const copy = AGENT_COPY[item.agent];
  const on = item.status === "on" || item.status === "starting";
  const per = limit?.per ?? "day";
  return (
    <SheetShell open={open} onOpenChange={(next) => !next && onClose()} title={item.name} description={copy.lead}>
      <SheetSteps stepKey="main" className="flex flex-col gap-3.5">
        <p className="m-0 flex items-start gap-2 rounded-[16px] bg-card-bone px-3 py-2.5 text-[13px] leading-[1.4] text-ink-2">
          <ShieldIcon size={14} className="mt-0.5 shrink-0 text-pos" />
          {copy.never}
        </p>

        <div className="flex flex-col gap-1.5 rounded-[22px] bg-card px-4 py-3.5 shadow-card-elev">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px] font-semibold">Status</span>
            <AgentPill tone={PILL[item.status].tone}>{PILL[item.status].text}</AgentPill>
          </div>
          <p className="num m-0 text-sm leading-[1.4] text-ink-2">{item.line}</p>
          {stops && (
            <p className="m-0 flex items-center gap-1.5 border-t border-hairline pt-2.5 text-[13px] text-ink-mid">
              Stops on {stops}
              <span aria-hidden>·</span>
              <button type="button" disabled={!live || busy} onClick={() => onAction("renew")} className="font-semibold text-ink underline-offset-2 hover:underline disabled:opacity-45">
                Renew
              </button>
            </p>
          )}
        </div>

        {!settingsSave && (
          <section className="flex flex-col gap-2">
            <Label>{per === "week" ? "Weekly limit" : "Daily limit"}</Label>
            {limit && limit.options.length > 1 ? (
              <div className="flex flex-col gap-2.5 rounded-[22px] bg-card px-4 py-3.5 shadow-card-elev">
                <LimitChips label={per === "week" ? "Weekly limit" : "Daily limit"} options={limit.options} value={limit.value} onChange={limit.onChange} per={`a ${limit.per}`} size="sm" />
                <span className="text-xs leading-[1.4] text-subtle">{neverMoreThan(item.name, per)}</span>
                {limit.changed &&
                  (on ? (
                    <TxButton label="Save" size="md" phase={busy ? "signing" : "idle"} preview={preview} disabled={!live} onClick={() => onAction("limit")} />
                  ) : (
                    <span className="text-xs text-subtle">It starts on this limit when you switch it on.</span>
                  ))}
              </div>
            ) : (
              <p className="num m-0 rounded-[22px] bg-card px-4 py-3.5 text-[15px] font-semibold shadow-card-elev">{item.limit}</p>
            )}
          </section>
        )}

        {settings}

        <section className="flex flex-col gap-2">
          <Label>What it did</Label>
          {activity}
        </section>

        <TxError error={error} />
        {(on || !settingsSave) && (
          <div className="flex items-center justify-between px-1 text-[13px]">
            <span className="text-ink-mid">{NETWORK_FEE_ROW.label}</span>
            <span className="font-semibold">{NETWORK_FEE_ROW.value}</span>
          </div>
        )}
        {on ? (
          <div className="flex flex-col items-center gap-0.5">
            <button
              type="button"
              disabled={!live || busy}
              aria-busy={busy}
              onClick={() => onAction("off")}
              className="flex h-11 items-center justify-center px-4 text-sm font-semibold text-act disabled:opacity-45"
            >
              Turn off
            </button>
            {stepsNote(offSteps) && <span className="text-xs text-subtle">{stepsNote(offSteps)}</span>}
          </div>
        ) : (
          !settingsSave && (
            <TxButton
              label="Switch on"
              size="md"
              phase={busy ? "signing" : "idle"}
              preview={live && preview}
              note={live ? null : "Not live yet"}
              disabled={!live || item.status === "loading"}
              onClick={() => onAction("on")}
            />
          )
        )}
      </SheetSteps>
    </SheetShell>
  );
}

/** One coin Receive converts: what's in the account, and when it's tried again if it's waiting for a fair price. */
export type ReceiveCoin = { symbol: string; name: string; amount: string | null; waitingUntil: string | null };

/** Receive's settings: the coins it converts on Base, what's in the account, and what's waiting. */
export function ReceiveCoins({ coins }: { coins: readonly ReceiveCoin[] }) {
  return (
    <section className="flex flex-col gap-2">
      <Label>Coins it converts</Label>
      <ul className="m-0 list-none rounded-[22px] bg-card px-4 py-0.5 shadow-card-elev">
        {coins.map((c) => (
          <li key={c.symbol} className="flex items-center gap-3 border-b border-hairline py-3 last:border-b-0">
            <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-card-bone text-xs font-bold">
              $
            </span>
            <span className="flex min-w-0 grow flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{c.symbol}</span>
              <span className="truncate text-xs text-subtle">{c.name}</span>
            </span>
            <span className="num flex shrink-0 flex-col items-end gap-0.5 text-right">
              <span className="text-sm font-semibold">{c.amount ?? "None"}</span>
              {c.waitingUntil && <span className="text-xs text-watch-ink">Waiting until {c.waitingUntil}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 px-1 text-xs leading-[1.4] text-subtle">Each at 99.5% of face value or better. A coin that can’t get it waits an hour and tries again.</p>
    </section>
  );
}

/** The line under a limit: "Protect never moves more than this in a day." */
export const neverMoreThan = (name: string, per: "day" | "week") => `${name} never moves more than this in a ${per}.`;

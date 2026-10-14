"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Button } from "./Button";
import { LimitChips } from "./LimitChips";
import { AgentPill } from "./Status";
import { NETWORK_FEE_ROW, Summary } from "./Summary";
import { FaceIdButton, TxError } from "./TxUi";
import { ChevronRight, ShieldIcon } from "./icons";
import { AGENT_COPY, type AgentItem, type ConfirmCopy, type SheetAction } from "@/lib/agents/list";
import type { AgentStatus } from "@/lib/agents/status";

/*
 * An agent's sheet (Adrian, 2026-10-15): what it does and never does, its state and next move, its limit, its own
 * settings, when it stops, what it did, and a way to switch it on or off. Every change is its own JAW screen, said on
 * a confirm step in the same sheet (SheetSteps).
 */

/** The confirm step, with what's needed to sign it. */
export type ConfirmView = ConfirmCopy & {
  busy: boolean;
  error: string | null;
  /** Why it can't go ahead now (not live, network fees), under the button; null when it can. */
  blocked: string | null;
  /** The dev preview (`?as=`): nothing can be signed. */
  preview: boolean;
  onConfirm: () => void;
};

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
  open, onClose, item, confirm, onBack, live, stops, limit, settings, settingsSave = false, activity, onAction,
}: {
  open: boolean;
  onClose: () => void;
  item: AgentItem;
  /** The confirm step when one is open; the sheet's own step otherwise. */
  confirm: ConfirmView | null;
  /** Back from the confirm step to the sheet, when the sheet led to it. */
  onBack?: () => void;
  live: boolean;
  /** "Oct 15, 2027": when its grant ends, while it has one. */
  stops: string | null;
  /** The limits it offers; without them the sheet shows the one it runs with. */
  limit?: LimitView;
  /** Its own settings: Receive's coins, Protect's and Rebalance's settings bodies. */
  settings?: ReactNode;
  /**
   * The settings carry the limit and their own Save, which also switches the agent on (Protect, Rebalance): the sheet
   * then shows no limit of its own and no Switch on, so there is one limit and one Face ID button on screen.
   */
  settingsSave?: boolean;
  activity: ReactNode;
  onAction: (a: SheetAction) => void;
}) {
  const copy = AGENT_COPY[item.agent];
  const on = item.status === "on" || item.status === "starting";
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={confirm ? confirm.title : item.name}
      description={confirm ? undefined : copy.lead}
      onBack={confirm && !confirm.busy ? onBack : undefined}
    >
      <SheetSteps stepKey={confirm ? `confirm:${confirm.title}` : "main"} direction={confirm ? "forward" : "back"} className="flex flex-col gap-3.5">
        {confirm ? (
          <AgentConfirm confirm={confirm} />
        ) : (
          <>
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
                  <button type="button" disabled={!live} onClick={() => onAction("renew")} className="font-semibold text-ink underline-offset-2 hover:underline disabled:opacity-45">
                    Renew
                  </button>
                </p>
              )}
            </div>

            {!settingsSave && (
              <section className="flex flex-col gap-2">
                <Label>Limit</Label>
                {limit && limit.options.length > 1 ? (
                  <div className="flex flex-col gap-2.5 rounded-[22px] bg-card px-4 py-3.5 shadow-card-elev">
                    <LimitChips label={`${item.name} can move up to, a ${limit.per}`} options={limit.options} value={limit.value} onChange={limit.onChange} per={`a ${limit.per}`} size="sm" />
                    {limit.changed &&
                      (on ? (
                        <Button variant="dark" disabled={!live} onClick={() => onAction("limit")}>
                          Save the new limit
                        </Button>
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

            {on ? (
              <button type="button" disabled={!live} onClick={() => onAction("off")} className="flex h-11 items-center justify-center text-sm font-semibold text-act disabled:opacity-45">
                Turn off {item.name}
              </button>
            ) : (
              !settingsSave && (
                <div className="flex flex-col gap-2">
                  <Button disabled={!live || item.status === "loading"} onClick={() => onAction("on")}>
                    Switch on {item.name}
                  </Button>
                  {!live && <p className="m-0 text-center text-xs text-subtle">Not live yet</p>}
                </div>
              )
            )}
          </>
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

/** A link to settings that live on their own screen for now. */
export function SettingsLink({ title, sub, href }: { title: string; sub: string; href: string }) {
  return (
    <section className="flex flex-col gap-2">
      <Label>Settings</Label>
      <Link href={href} className="flex items-center gap-3 rounded-[22px] bg-card px-4 py-3.5 text-ink no-underline shadow-card-elev">
        <span className="flex grow flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{title}</span>
          <span className="text-xs leading-[1.35] text-subtle">{sub}</span>
        </span>
        <ChevronRight size={16} className="shrink-0 text-subtle" />
      </Link>
    </section>
  );
}

/** The confirm step: what changes, then JAW's own screen behind one Face ID button. */
export function AgentConfirm({ confirm }: { confirm: ConfirmView }) {
  return (
    <>
      <p className="m-0 text-[15px] leading-[1.45] text-ink-2">{confirm.lead}</p>
      <Summary rows={[...confirm.rows, NETWORK_FEE_ROW]} />
      <TxError error={confirm.error} />
      <FaceIdButton
        label={confirm.button}
        size="md"
        phase={confirm.busy ? "signing" : "idle"}
        preview={confirm.preview}
        disabled={!!confirm.blocked}
        onClick={confirm.onConfirm}
      />
      <p className="m-0 text-center text-xs text-subtle">{confirm.blocked ?? confirm.note}</p>
    </>
  );
}

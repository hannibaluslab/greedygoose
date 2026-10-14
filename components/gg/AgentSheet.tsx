"use client";

import type { ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AgentPill } from "./Status";
import { NETWORK_FEE_ROW, Summary } from "./Summary";
import { FaceIdButton, TxError } from "./TxUi";
import { ShieldIcon } from "./icons";
import { AGENT_COPY, type AgentItem, type ConfirmCopy, type SheetAction } from "@/lib/agents/list";
import type { AgentStatus } from "@/lib/agents/status";

/*
 * An agent's sheet (Adrian, 2026-10-15): what it does and never does, its state and next move, its own settings (which
 * carry its limit and the Face ID button that saves it or switches it on), when it stops, what it did, and a way to
 * turn it off. Every change is its own JAW screen, said on a confirm step in the same sheet (SheetSteps).
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

const PILL: Record<AgentStatus, { text: string; tone: "on" | "neutral" }> = {
  unconfigured: { text: "Not live yet", tone: "neutral" },
  loading: { text: "…", tone: "neutral" },
  off: { text: "Off", tone: "neutral" },
  starting: { text: "Starting", tone: "neutral" },
  on: { text: "On", tone: "on" },
};

const Label = ({ children }: { children: ReactNode }) => <h3 className="label m-0 px-1">{children}</h3>;

export function AgentSheet({
  open, onClose, item, confirm, onBack, live, stops, settings, activity, onAction,
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
  /**
   * Its settings body (Protect's, Rebalance's): the limit and its own Face ID button, which also switches the agent on,
   * so there is one limit and one Face ID button on screen.
   */
  settings: ReactNode;
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

            {settings}

            <section className="flex flex-col gap-2">
              <Label>What it did</Label>
              {activity}
            </section>

            {on && (
              <button type="button" disabled={!live} onClick={() => onAction("off")} className="flex h-11 items-center justify-center text-sm font-semibold text-act disabled:opacity-45">
                Turn off {item.name}
              </button>
            )}
          </>
        )}
      </SheetSteps>
    </SheetShell>
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

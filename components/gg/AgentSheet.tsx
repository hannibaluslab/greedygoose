"use client";

import type { ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { AgentPill } from "./Status";
import { TxError } from "./TxUi";
import { ShieldIcon } from "./kit/icons";
import { FinishBlock, type FinishState } from "./agents/FinishTurningOn";
import { AGENT_COPY, type AgentItem, type SheetAction } from "@/lib/agents/list";
import type { AgentStatus } from "@/lib/agents/status";
import { stepsNote } from "@/lib/formatting";

/*
 * An agent's sheet (Adrian, 2026-10-15): what it does and never does, its state and next move, its own settings (which
 * carry the button that saves it or switches it on, and the Rebalancer's limit; Protect has none), when it stops, what
 * it did, and a way to turn it off. The sheet already says what a change does, so there is no confirm step of ours: Renew and Turn off open JAW's
 * own sheet straight away, once a grant or revoke (a small line says "2 steps" when there are more).
 */

const PILL: Record<AgentStatus, { text: string; tone: "on" | "neutral" }> = {
  unconfigured: { text: "Coming soon", tone: "neutral" },
  loading: { text: "…", tone: "neutral" },
  off: { text: "Off", tone: "neutral" },
  starting: { text: "Starting", tone: "neutral" },
  on: { text: "On", tone: "on" },
};

const Label = ({ children }: { children: ReactNode }) => <h3 className="label m-0 px-1">{children}</h3>;

export function AgentSheet({
  open,
  onClose,
  item,
  live,
  busy,
  error,
  offSteps,
  stops,
  settings,
  activity,
  onAction,
  warnings,
  finish,
}: {
  open: boolean;
  onClose: () => void;
  item: AgentItem;
  live: boolean;
  /** JAW's sheet is open for one of this sheet's changes: its buttons wait. */
  busy: boolean;
  /** What went wrong with the last change, if it didn't go through. */
  error: string | null;
  /** How many times turning it off opens JAW's sheet: once for each grant JAW lists. */
  offSteps: number;
  /** "Oct 15, 2027": when its grant ends, while it has one. */
  stops: string | null;
  /**
   * Its settings body (Protect's, Rebalance's): its own button to JAW's sheet, which also switches the agent on, and the
   * Rebalancer's limit, so there is one limit and one such button on screen.
   */
  settings: ReactNode;
  activity: ReactNode;
  onAction: (a: SheetAction) => void;
  /** Warnings about the credit, each with Top up and Repay (Protect's sheet: Act, the weekend). */
  warnings?: ReactNode;
  /**
   * While JAW granted it and the executor doesn't run it yet: the batch that registers it (useTx with useAgents'
   * `finishPlan`), sent from here now the overview has no cards.
   */
  finish?: FinishState;
}) {
  const copy = AGENT_COPY[item.agent];
  const on = item.status === "on" || item.status === "starting";
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
              <button
                type="button"
                disabled={!live || busy}
                onClick={() => onAction("renew")}
                className="font-semibold text-ink underline-offset-2 hover:underline disabled:opacity-45"
              >
                Renew
              </button>
            </p>
          )}
        </div>

        {warnings}
        {finish && <FinishBlock finish={finish} disabled={!live || busy} />}

        {settings}

        <section className="flex flex-col gap-2">
          <Label>What it did</Label>
          {activity}
        </section>

        <TxError error={error} />
        {on && (
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
        )}
      </SheetSteps>
    </SheetShell>
  );
}

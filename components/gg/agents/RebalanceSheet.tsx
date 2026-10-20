"use client";

import type { ReactNode } from "react";
import { SheetShell } from "@/components/gg/kit/SheetShell";
import { TxError } from "@/components/gg/TxUi";
import { FinishBlock, type FinishState } from "./FinishTurningOn";
import { RebalancePill } from "./RebalanceCard";
import { RebalanceSettings } from "./RebalanceSettings";
import { useAgents } from "@/hooks/useAgents";
import { useRebalanceCard } from "@/hooks/useRebalanceCard";
import { AGENTS_LIVE } from "@/lib/agents/config";
import type { SheetAction } from "@/lib/agents/list";
import type { RebalanceCardModel } from "@/lib/agents/rebalanceCard";
import { sheetLine } from "@/lib/agents/rebalanceSettings";

/*
 * Rebalance's sheet (boards 7e–7h, Adrian 2026-10-20: "The Rebalance sheet keeps only my mix and the top-ups
 * setting"): its pill and one line under the title, from the same model as its overview card; My mix and Top-ups go
 * into my mix with their Save (RebalanceSettings); and a quiet Turn off Rebalance. What it did lives on the overview.
 * Turn off and Renew go through the Agents page's runner (`onAction`), as Protect's sheet does, each one batch, one
 * Face ID (useAgents `changePlan`); Finish too (`finish`), which stands where the line is while JAW granted it and the
 * executor doesn't run it yet.
 */

export function RebalanceSheet({
  account,
  open,
  onClose,
  busy,
  error,
  onAction,
  finish,
}: {
  account: `0x${string}`;
  open: boolean;
  onClose: () => void;
  /** JAW's sheet is open for Turn off, Renew or Finish: their buttons wait. */
  busy: boolean;
  /** What stopped the last Turn off or Renew. */
  error: string | null;
  onAction: (a: Exclude<SheetAction, "on">) => void;
  finish?: FinishState;
}) {
  const model = useRebalanceCard(account);
  const agents = useAgents(account);
  const status = agents.status.rebalance;
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Rebalance"
      titleAccessory={<RebalancePill model={model} />}
    >
      <RebalanceSheetBody
        model={model}
        live={AGENTS_LIVE}
        on={status === "on" || status === "starting"}
        busy={busy}
        error={error}
        onAction={onAction}
        finish={finish}
        settings={<RebalanceSettings account={account} />}
      />
    </SheetShell>
  );
}

/** The sheet under its title, from plain values, so the dev gallery draws each state. */
export function RebalanceSheetBody({
  model,
  live,
  on,
  busy,
  error,
  onAction,
  finish,
  settings,
}: {
  model: RebalanceCardModel | null;
  live: boolean;
  /** It runs (on, or registering): Turn off shows. */
  on: boolean;
  busy: boolean;
  error: string | null;
  onAction: (a: Exclude<SheetAction, "on">) => void;
  finish?: FinishState;
  settings: ReactNode;
}) {
  const line = model && sheetLine(model);
  return (
    <div className="flex flex-col gap-3">
      {finish ? (
        <FinishBlock finish={finish} disabled={!live || busy} sub="Until then, nothing trades." />
      ) : line ? (
        <p className="num m-0 px-0.5 text-sm leading-[19px] text-ink-mid">
          {line.text}
          {line.renew && (
            <>
              {" "}
              {/* Inline in the line, it takes taps 45 tall (13px above and below its text), the 44px touch target. */}
              <button
                type="button"
                disabled={!live || busy}
                onClick={() => onAction("renew")}
                className="relative font-semibold text-ink underline-offset-2 before:absolute before:-inset-x-2 before:-inset-y-[13px] hover:underline disabled:opacity-45"
              >
                Renew
              </button>
            </>
          )}
        </p>
      ) : (
        <span aria-hidden className="h-[19px] w-3/4 animate-pulse rounded-md bg-chip" />
      )}

      {settings}

      <TxError error={error} />
      {on && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={!live || busy}
            aria-busy={busy}
            onClick={() => onAction("off")}
            className="flex h-11 items-center justify-center px-4 text-sm font-medium text-ink-mid disabled:opacity-45"
          >
            Turn off Rebalance
          </button>
        </div>
      )}
    </div>
  );
}

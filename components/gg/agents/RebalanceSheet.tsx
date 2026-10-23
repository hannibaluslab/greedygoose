"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "@/components/gg/kit/icons";
import { SheetShell } from "@/components/gg/kit/SheetShell";
import { StockAvatar } from "@/components/gg/kit/StockAvatar";
import { TxError } from "@/components/gg/TxUi";
import { FinishBlock, type FinishState } from "./FinishTurningOn";
import { RebalancePill } from "./RebalanceCard";
import { RebalanceSettings } from "./RebalanceSettings";
import { useAgents } from "@/hooks/useAgents";
import { useRebalanceCard } from "@/hooks/useRebalanceCard";
import { AGENTS_LIVE } from "@/lib/agents/config";
import type { SheetAction } from "@/lib/agents/list";
import { BACKING_RULE } from "@/lib/agents/next";
import type { RebalanceCardModel, TradeMove } from "@/lib/agents/rebalanceCard";
import { sheetLine } from "@/lib/agents/rebalanceSettings";
import { formatUsd } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";

/*
 * Rebalance's sheet (boards 7e–7h, Adrian 2026-10-20: "The Rebalance sheet keeps only my mix and the top-ups
 * setting"): its pill and one line under the title, from the same model as its overview card; My mix and Top-ups go
 * into my mix with their Save (RebalanceSettings); and a quiet Turn off Rebalance. What it did lives on the overview.
 * Turn off and Renew go through the Agents page's runner (`onAction`), as Protect's sheet does, each one batch, one
 * Face ID (useAgents `changePlan`); Finish too (`finish`), which stands where the line is while JAW granted it and the
 * executor doesn't run it yet. Under the line, always, its rule: stock that backs credit isn't rebalanced (Adrian,
 * 2026-10-21), unless the line already says it.
 */

export function RebalanceSheet({
  account,
  open,
  onClose,
  busy,
  confirming = false,
  error,
  onAction,
  finish,
}: {
  account: `0x${string}`;
  open: boolean;
  onClose: () => void;
  /** JAW's sheet is open for Turn off, Renew or Finish: their buttons wait. */
  busy: boolean;
  /** Turn off or Renew is confirming on Base: the whole sheet waits. */
  confirming?: boolean;
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
      title="Rebalancer"
      titleAccessory={<RebalancePill model={model} />}
      confirming={confirming}
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

/**
 * The next check's trades behind one row (Adrian, 2026-10-23: "see exactly what are the actions one by one"): open,
 * each swap in the order GooseGuard makes it, its stock and its dollars.
 */
function NextTrades({ moves }: { moves: readonly TradeMove[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[22px] bg-card shadow-card-elev">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-[15px] font-semibold"
      >
        {moves.length === 1 ? "See the trade" : `See the ${moves.length} trades`}
        <ChevronDown className={`shrink-0 text-ink-mid transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-hairline px-4 pb-3.5 pt-1">
          <ol className="m-0 list-none p-0">
            {moves.map((m, i) => {
              const stock = EQUITIES[m.reserveId];
              return (
                <li key={`${m.side}:${m.reserveId}`} className="num flex items-center gap-2.5 py-2">
                  <span className="w-4 shrink-0 text-[13px] text-ink-mid">{i + 1}</span>
                  <StockAvatar symbol={stock.symbol} size={28} />
                  <span className="min-w-0 grow truncate text-sm font-semibold">
                    <span className={m.side === "buy" ? "text-pos" : "text-neg"}>
                      {m.side === "buy" ? "Buy" : "Sell"}
                    </span>{" "}
                    {stock.name}
                  </span>
                  <span className="shrink-0 text-sm font-semibold">{formatUsd(m.usd)}</span>
                </li>
              );
            })}
          </ol>
          {moves.some((m) => m.side === "sell") && moves.some((m) => m.side === "buy") && (
            <p className="m-0 pt-1 text-[13px] leading-[18px] text-ink-mid">Sales go first and pay for the buys.</p>
          )}
        </div>
      )}
    </div>
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
      {!line?.text.includes(BACKING_RULE) && (
        <p className="m-0 -mt-1.5 px-0.5 text-[13px] leading-[18px] text-ink-mid">{BACKING_RULE}</p>
      )}
      {!finish && model && model.moves.length > 0 && <NextTrades moves={model.moves} />}

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
            Turn off Rebalancer
          </button>
        </div>
      )}
    </div>
  );
}

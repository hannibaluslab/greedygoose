"use client";

import { AmountInput } from "./AmountInput";
import { useState } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { useAccount } from "wagmi";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { StatusPill } from "./Status";
import { NETWORK_FEE_ROW } from "./Summary";
import { TxButton, TxDone, TxError } from "./TxUi";
import { useTx } from "@/hooks/useTx";
import { withdrawPlan } from "@/lib/tx/plans";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { Holding, PositionData } from "@/hooks/usePosition";
import { freeUpCheck } from "@/lib/freeUp";
import { rawToShares, sharesToRaw } from "@/lib/tokens/b20";
import { formatShares, formatUsd } from "@/lib/formatting";
import type { ReserveAsset } from "@/lib/tokens/registry";

/**
 * "Free up shares": withdraw a stock from Aave back to the user's account, straight to JAW's own sheet from the amount
 * (with the risk tick on this screen when it ends in Watch; the batch is prepared while the sheet is idle). Act is the
 * line (Adrian, 2026-10-15): the most it frees up keeps the health factor at or above CREDIT_CAP.minHf, the same line
 * as taking credit, and an amount that would end in Act is blocked with one plain line, never a tick (lib/freeUp.ts).
 * `onBack` when opened from the stock's sheet.
 */
export function UnlockSheet({
  open, user, stock, holding, data, cf, onClose, onBack,
}: {
  open: boolean;
  user: `0x${string}`;
  stock: ReserveAsset;
  holding: Holding;
  data: PositionData;
  cf: number | undefined;
  onClose: () => void;
  onBack?: () => void;
}) {
  const { isConnected } = useAccount();
  const fee = useFeeSupport();
  const [raw, setRaw] = useState("");
  const [all, setAll] = useState(false);
  const [ack, setAck] = useState(false);

  const ticker = tickerOf(stock.symbol);
  const lockedShares = rawToShares(holding.lockedRaw, holding.multiplier, stock.decimals);
  const amountRaw = all ? holding.lockedRaw : sharesToRaw(raw, holding.multiplier, stock.decimals);
  // With debt, the most is what keeps the credit at the cap's line (Watch at worst); ending in Act is blocked.
  const { canAll, maxShares, usd, after, risky, line, ok } = freeUpCheck({ position: data, holding, decimals: stock.decimals, cf: cf ?? 0, amountRaw, all });
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Free up would sign now, prepared while the sheet is idle so the tap opens JAW's sheet at once.
  const plan = open && ok && !(risky && !ack) && !holding.paused && !feeBlocked && cf !== undefined ? withdrawPlan({ user, stock, amountRaw, all }) : null;
  const tx = useTx(undefined, plan);

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={`Free up ${stock.name}`}
      onBack={onBack && !tx.busy && tx.phase !== "done" ? onBack : undefined}
    >
      <SheetSteps stepKey={tx.phase === "done" ? "done" : "amount"} className="flex flex-col gap-3">
        {tx.phase === "done" ? (
          <TxDone title={`${ticker} freed up`} body="It’s back in your account as a free stock." txHash={tx.txHash} onDone={onClose} />
        ) : (
          <>
            <div className="flex flex-col gap-2 rounded-2xl border border-ink bg-card p-3.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">Shares</span>
                <span className="text-xs text-subtle">Can free up: {formatShares(Math.max(0, maxShares))}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <StockAvatar symbol={stock.symbol} />
                <label className="num flex flex-1 items-center">
                  <span className="sr-only">Number of shares</span>
                  <AmountInput
                    autoFocus
                    decimals={6}
                    value={all ? String(Math.floor(lockedShares * 1e6) / 1e6) : raw}
                    onValue={(v) => {
                      setAll(false);
                      setAck(false);
                      setRaw(v);
                    }}
                    className="text-[30px] font-semibold leading-none tracking-[-0.03em]"
                  />
                  <span className="ml-1 text-sm font-semibold text-subtle">{ticker}</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setAck(false);
                    if (canAll) setAll(true);
                    else setRaw(String(Math.floor(Math.max(0, maxShares) * 1e6) / 1e6));
                  }}
                  className="flex h-7 items-center rounded-[14px] bg-[rgba(15,14,11,0.06)] px-2.5 text-xs font-semibold text-ink-mid"
                >
                  {canAll ? "ALL" : "MAX"}
                </button>
              </div>
              <span className="num text-xs text-subtle">Worth {formatUsd(usd)} at Aave’s price · {formatShares(lockedShares)} in use</span>
            </div>

            <div className="num rounded-[22px] bg-card px-4 py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
              <div className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
                <span className="text-ink-mid">You owe</span>
                <span className="font-semibold">{formatUsd(data.debtUsd)}</span>
              </div>
              <div className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
                <span className="text-ink-mid">Status</span>
                <span className="flex items-center gap-2"><StatusPill status={data.status} /> → <StatusPill status={amountRaw > 0n ? after : data.status} /></span>
              </div>
              <div className="flex items-center justify-between py-3 text-[15px]">
                <span className="text-ink-mid">{NETWORK_FEE_ROW.label}</span>
                <span className="font-semibold">{NETWORK_FEE_ROW.value}</span>
              </div>
            </div>

            {line && <p role="status" className="m-0 text-[13px] text-act">{line}</p>}
            {risky && (
              <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
                I understand this puts my credit in Watch. If my stocks fall too far, part of them can be sold to repay what I owe.
              </label>
            )}
            {holding.paused && <p role="status" className="m-0 text-[13px] text-act">Aave has paused {stock.name} for now.</p>}
            {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">Your account can’t pay network fees in USDC on Base right now.</p>}
            <TxError error={tx.error} />
            <TxButton
              label="Free up"
              phase={tx.phase}
              checking={tx.checking}
              preview={!isConnected}
              disabled={!plan || fee.loading || tx.blocked}
              onClick={() => {
                if (!plan) return;
                if (tx.phase === "failed") tx.reset();
                void tx.sign();
              }}
            />
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

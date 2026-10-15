"use client";

import { AmountInput } from "./AmountInput";
import { useState } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { useAccount } from "wagmi";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { StatusPill } from "./Status";
import { NETWORK_FEE_ROW } from "./Summary";
import { TxButton, TxDone, TxError } from "./TxUi";
import { txKey, useTx, type TxPlan } from "@/hooks/useTx";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { Holding, PositionData } from "@/hooks/usePosition";
import { buildWithdrawCalls } from "@/lib/aave/tx";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { needsExtraConfirm, statusFor } from "@/lib/risk/status";
import { rawToShares, sharesToRaw } from "@/lib/tokens/b20";
import { formatShares, formatUsd } from "@/lib/formatting";
import type { ReserveAsset } from "@/lib/tokens/registry";

/**
 * "Free up shares": withdraw a stock from Aave back to the user's account, straight to JAW's own sheet from the amount
 * (with the risk tick on this screen when it ends in Watch or Act; the batch is prepared while the sheet is idle).
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
  const factor = cf ?? 0;
  const maxUsd = maxWithdrawUsd({ collateralUsd: data.collateralUsd, avgCf: data.avgCf, debtUsd: data.debtUsd, cf: factor, lockedUsd: holding.lockedUsd });
  const canAll = data.debtUsd === 0 || maxUsd >= holding.lockedUsd;
  // With debt, leave 0.5% headroom below Aave's limit for interest and price moves.
  const maxShares = canAll ? lockedShares : (lockedShares * (maxUsd / Math.max(holding.lockedUsd, 1e-9))) * 0.995;

  const amountRaw = all ? holding.lockedRaw : sharesToRaw(raw, holding.multiplier, stock.decimals);
  const shares = rawToShares(amountRaw, holding.multiplier, stock.decimals);
  const usd = (Number(amountRaw) / 10 ** stock.decimals) * holding.priceUsd;
  const tooMuch = !all && shares > maxShares + 1e-12;
  const hfAfter = healthAfterWithdraw({ collateralUsd: data.collateralUsd, avgCf: data.avgCf, debtUsd: data.debtUsd, cf: factor, usd });
  const after = statusFor(hfAfter);
  const risky = amountRaw > 0n && needsExtraConfirm(after);
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Free up would sign now, prepared while the sheet is idle so the tap opens JAW's sheet at once.
  const plan: TxPlan | null =
    open && amountRaw > 0n && !tooMuch && !(risky && !ack) && !holding.paused && !feeBlocked && cf !== undefined
      ? {
          key: txKey("withdraw", user, stock.symbol, amountRaw, all),
          user,
          calls: () => Promise.resolve(buildWithdrawCalls({ user, stock, amountRaw, all })),
          activity: [{ kind: "withdraw", symbol: stock.symbol, amount: Number(amountRaw) / 10 ** stock.decimals }],
        }
      : null;
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

            {data.debtUsd > 0 && maxUsd <= 0 && (
              <p role="status" className="m-0 text-[13px] text-act">Your credit needs all of these shares. Repay some first to free them up.</p>
            )}
            {tooMuch && <p role="status" className="m-0 text-[13px] text-act">That’s more than you can free up while you owe {formatUsd(data.debtUsd)}.</p>}
            {risky && !tooMuch && (
              <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
                I understand this puts my loan in {after === "act" ? "Act" : "Watch"}. If my stocks fall, Aave can sell part of them.
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

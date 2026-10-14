"use client";

import { Sheet } from "./Sheet";
import { AmountInput } from "./AmountInput";
import { useState } from "react";
import { useAccount } from "wagmi";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { StatusPill } from "./Status";
import { FaceIdButton, TxDone, TxError } from "./TxUi";
import { useTx } from "@/hooks/useTx";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { Holding, PositionData } from "@/hooks/usePosition";
import { buildWithdrawCalls } from "@/lib/aave/tx";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { needsExtraConfirm, statusFor } from "@/lib/risk/status";
import { rawToShares, sharesToRaw } from "@/lib/tokens/b20";
import { formatShares, formatUsd } from "@/lib/formatting";
import type { ReserveAsset } from "@/lib/tokens/registry";

/** Withdraw ("unlock") a stock from Aave back to the user's account. */
export function UnlockSheet({
  user, stock, holding, data, cf, onClose,
}: { user: `0x${string}`; stock: ReserveAsset; holding: Holding; data: PositionData; cf: number | undefined; onClose: () => void }) {
  const { isConnected } = useAccount();
  const fee = useFeeSupport();
  const tx = useTx();
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

  return (
    <Sheet label={`Unlock ${stock.name}`} onClose={onClose}>
        <div className="flex items-center gap-2.5 pt-1">
          <StockAvatar symbol={stock.symbol} />
          <h2 className="m-0 min-w-0 flex-1 text-xl font-semibold tracking-[-0.02em]">Unlock {stock.name}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-2xl bg-[rgba(15,14,11,0.06)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {tx.phase === "done" ? (
          <TxDone title={`${ticker} unlocked`} body="It’s back in your account as a free stock." txHash={tx.txHash} onDone={onClose} />
        ) : (
          <>
            <div className="flex flex-col gap-2 rounded-2xl border border-ink bg-card p-3.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">Shares</span>
                <span className="text-xs text-subtle">Can unlock: {formatShares(Math.max(0, maxShares))}</span>
              </div>
              <div className="flex items-center gap-2.5">
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
              <span className="num text-xs text-subtle">Worth {formatUsd(usd)} at Aave’s price · {formatShares(lockedShares)} locked</span>
            </div>

            <div className="num rounded-[22px] bg-card px-4 py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
              <div className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
                <span className="text-ink-mid">You owe</span>
                <span className="font-semibold">{formatUsd(data.debtUsd)}</span>
              </div>
              <div className="flex items-center justify-between py-3 text-[15px]">
                <span className="text-ink-mid">Status</span>
                <span className="flex items-center gap-2"><StatusPill status={data.status} /> → <StatusPill status={amountRaw > 0n ? after : data.status} /></span>
              </div>
            </div>

            {data.debtUsd > 0 && maxUsd <= 0 && (
              <p role="status" className="m-0 text-[13px] text-act">Your loan needs all of this collateral. Repay some first to unlock it.</p>
            )}
            {tooMuch && <p role="status" className="m-0 text-[13px] text-act">That’s more than you can unlock while you owe {formatUsd(data.debtUsd)}.</p>}
            {risky && !tooMuch && (
              <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
                I understand this puts my loan in {after === "act" ? "Act" : "Watch"}. If my stocks fall, Aave can sell part of them.
              </label>
            )}
            {holding.paused && <p role="status" className="m-0 text-[13px] text-act">Aave has paused {stock.name} for now.</p>}
            {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">Your account can’t pay network fees in USDC on Base right now.</p>}
            <TxError error={tx.error} />
            <FaceIdButton
              label={amountRaw > 0n ? `Unlock ${all ? "all" : formatShares(shares)} ${ticker} with Face ID` : `Unlock ${ticker} with Face ID`}
              phase={tx.phase}
              preview={!isConnected}
              disabled={amountRaw === 0n || tooMuch || (risky && !ack) || holding.paused || feeBlocked || fee.loading || cf === undefined}
              onClick={() => {
                if (tx.phase === "failed") tx.reset();
                void tx.run(user, buildWithdrawCalls({ user, stock, amountRaw, all }), undefined, [
                  { kind: "withdraw", symbol: stock.symbol, amount: Number(amountRaw) / 10 ** stock.decimals },
                ]);
              }}
            />
          </>
        )}
    </Sheet>
  );
}

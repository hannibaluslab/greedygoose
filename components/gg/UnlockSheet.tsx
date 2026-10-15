"use client";

import { useId, useState } from "react";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountInput } from "./AmountInput";
import { CashMark } from "./AssetPicker";
import { Chip, PencilIcon } from "./RepaySheet";
import { Summary } from "./Summary";
import { TxButton, TxDone, TxError } from "./TxUi";
import { useTx } from "@/hooks/useTx";
import { freeUpPlan, useFreeUpBatch } from "@/hooks/useFreeUp";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { Holding, PositionData } from "@/hooks/usePosition";
import { maxSpendRaw, toUsd } from "@/lib/cash";
import { freeUpByRepay } from "@/lib/freeUp";
import { formatUsd } from "@/lib/formatting";
import { quickPicks } from "@/lib/repay";
import { endsInAct, needsExtraConfirm } from "@/lib/risk/status";
import type { ReserveAsset } from "@/lib/tokens/registry";

/**
 * "Free up Amazon" (Adrian, 2026-10-15: "super confusing"; the layout he approved): in dollars, one idea per block.
 * What of the stock backs the credit and the repay that gets all of it back; one amount, what you repay from your cash
 * (typed, or 25 / 50 / 75% / All); what comes back for it and what you owe after; one button that repays and takes the
 * shares out of backing in one signature (useFreeUpBatch). With nothing to repay it says so and frees all of it. The
 * most that comes back keeps the health at the cap's line (lib/freeUp.ts freeUpByRepay); ending in Watch keeps D2's
 * tick, and the batch may not end in Act. `onBack` when opened from the stock's sheet.
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
  const batch = useFreeUpBatch();
  const id = useId();
  // null: the most (the sheet opens on it); else the dollars typed or picked.
  const [field, setField] = useState<string | null>(null);
  const [ack, setAck] = useState(false);

  const cashUsd = toUsd(maxSpendRaw(data.cash));
  const f = freeUpByRepay({ position: data, holding, cf: cf ?? 0, cashUsd, repayUsd: field === null ? null : Number(field || 0) });
  const loading = data.debtUsd > 0 && cf === undefined;
  const needsRepay = f.allRepayUsd > 0;
  const picks = quickPicks({ usd: f.maxRepayUsd, raw: 0n, coversAll: false, quoting: false });
  const maxLabel = f.maxRepayUsd >= f.allRepayUsd ? "All" : "Max";
  const something = f.all || f.backRaw > 0n;
  const inAct = something && endsInAct(f.after);
  const risky = something && !inAct && needsExtraConfirm(f.after);
  const feeBlocked = isConnected && fee.state === "unsupported";
  const pick = (v: string | null) => {
    if (tx.phase === "failed") tx.reset();
    setAck(false);
    setField(v);
  };
  // What Free up would sign now, prepared while the sheet is idle so the tap opens JAW's sheet at once.
  const plan =
    open && !loading && something && !inAct && !(risky && !ack) && !holding.paused && !feeBlocked
      ? freeUpPlan({ user, stock, repayUsd: f.repayUsd, repaysAll: f.repaysAll, backRaw: f.backRaw, all: f.all }, batch)
      : null;
  const tx = useTx(undefined, plan);

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={`Free up ${stock.name}`}
      onBack={onBack && !tx.busy && tx.phase !== "done" ? onBack : undefined}
    >
      <SheetSteps stepKey={tx.phase === "done" ? "done" : "amount"} className="flex flex-col gap-4">
        {tx.phase === "done" ? (
          <TxDone title={`${stock.name} freed up`} body="It’s back in your account as a free stock." txHash={tx.txHash} onDone={onClose} />
        ) : loading ? (
          <div aria-busy className="h-[320px] animate-pulse rounded-[22px] bg-chip" />
        ) : (
          <>
            <div className="flex flex-col gap-1 px-1 leading-snug">
              <p className="m-0 text-[17px] text-ink">
                <b className="num font-semibold">{formatUsd(f.backsUsd)}</b> of {stock.name} backs your credit
              </p>
              <p className="m-0 text-[15px] text-ink-mid">
                {needsRepay ? (
                  <>
                    Repay <b className="num font-semibold text-ink">{formatUsd(f.allRepayUsd)}</b> to get all of it back
                  </>
                ) : (
                  "You can get all of it back now"
                )}
              </p>
            </div>

            {needsRepay && (
              <div className="flex flex-col gap-2.5">
                <label htmlFor={id} className="px-1 text-[15px] font-semibold text-ink">How much do you repay?</label>
                <div className="flex items-center gap-3">
                  <span className="num flex h-12 min-w-0 flex-1 items-center rounded-[14px] border-[1.5px] border-line-strong bg-card px-3 font-semibold transition-colors focus-within:border-ink">
                    <span aria-hidden className="mr-0.5 text-[17px] text-subtle">$</span>
                    <AmountInput
                      id={id}
                      value={field === null ? f.repayUsd.toFixed(2) : field}
                      onValue={(v) => pick(v)}
                      className="text-[22px] leading-none tracking-[-0.02em]"
                    />
                    <PencilIcon aria-hidden className="ml-1 shrink-0 text-subtle" />
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-[12px] text-ink-mid">
                    You have
                    <span className="num flex items-center gap-1.5 text-[15px] font-semibold text-ink">
                      <CashMark size={18} />
                      {formatUsd(data.cashUsd)}
                    </span>
                  </span>
                </div>
                <div role="radiogroup" aria-label="Amount to repay" className="grid gap-2" style={{ gridTemplateColumns: `repeat(${picks.length + 1}, minmax(0, 1fr))` }}>
                  {picks.map((q) => (
                    <Chip key={q.share} selected={field !== null && Number(field) === q.usd} onClick={() => pick(q.usd.toFixed(2))}>
                      {Math.round(q.share * 100)}%
                    </Chip>
                  ))}
                  <Chip selected={field === null || Number(field) === f.maxRepayUsd} onClick={() => pick(null)}>{maxLabel}</Chip>
                </div>
                {f.snapped && (
                  <p role="status" className="m-0 px-1 text-[13px] leading-snug text-ink-mid">
                    {f.maxRepayUsd < f.allRepayUsd ? "That’s the most your cash can repay." : "That’s all it takes to get all of it back."}
                  </p>
                )}
              </div>
            )}

            <Summary
              rows={[
                { label: "You get back", value: something ? `${formatUsd(f.backUsd)} of ${stock.name}` : "—" },
                { label: "You owe after", value: formatUsd(f.oweAfterUsd) },
              ]}
            />

            {!something && needsRepay && f.maxRepayUsd <= 0 && (
              <p role="status" className="m-0 px-1 text-[13px] leading-snug text-ink-mid">Add cash to repay and get it back.</p>
            )}
            {inAct && <p role="status" className="m-0 text-[13px] text-act">That would put your credit in Act. Repay more.</p>}
            {risky && (
              <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
                I understand this keeps my credit in Watch. If my stocks fall too far, part of them can be sold to repay what I owe.
              </label>
            )}
            {holding.paused && <p role="status" className="m-0 text-[13px] text-act">Aave has paused {stock.name} for now.</p>}
            {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">Your account can’t pay network fees in USDC on Base right now.</p>}
            <TxError error={tx.error} />
            <TxButton
              label={f.repayUsd > 0 ? `Repay ${formatUsd(f.repayUsd)}` : "Free up"}
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

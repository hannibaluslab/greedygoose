"use client";

import { AmountInput } from "./AmountInput";
import { useState } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { useAccount } from "wagmi";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useBuy } from "@/hooks/useBuy";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { BUY_LIMITS, minOut, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { marketState } from "@/lib/market-hours";
import { FaceIdButton, TxError } from "./TxUi";
import { formatUsd } from "@/lib/formatting";
import { cashRaw, maxSpendRaw, savingsWithdrawal, toUsd, type Cash } from "@/lib/cash";
import { CASH } from "@/config/risk";
import type { ReserveAsset } from "@/lib/tokens/registry";

/** Design board "F1 · 4 · Buy sheet" (F1-4-Buy.dc.html) and its Review step; a landed buy goes Home (F1-6). */
export function BuySheet({
  open, user, stock, oraclePriceUsd, cash, onClose,
}: { open: boolean; user: `0x${string}`; stock: ReserveAsset; oraclePriceUsd: number; cash: Cash; onClose: () => void }) {
  const { isConnected } = useAccount();
  const [raw, setRaw] = useState("");
  const [step, setStep] = useState<"amount" | "review">("amount");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const go = (next: "amount" | "review") => {
    setDirection(next === "review" ? "forward" : "back");
    setStep(next);
  };
  const amount = Math.max(0, Number(raw.replace(/[^0-9.]/g, "")) || 0);
  const quote = useBuyQuote(stock, amount);
  const fee = useFeeSupport();
  const { buy, phase, error, reset, txHash } = useBuy();
  useBoughtHome({ phase, user, symbol: stock.symbol, txHash, onClose });

  const q = quote.data ?? null;
  const econ = q ? quoteEconomics(q, stock, oraclePriceUsd) : null;
  const cashUsd = toUsd(cashRaw(cash));
  const maxUsd = toUsd(maxSpendRaw(cash));
  const fromSavings = q ? savingsWithdrawal(q.amountIn, cash) : null;
  const closed = !marketState().open;
  const ticker = tickerOf(stock.symbol);

  let blocker: string | null = null;
  if (amount > 0 && amount < BUY_LIMITS.minUsd) blocker = `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`;
  else if (amount > cashUsd) blocker = "That’s more than your cash.";
  else if (amount > maxUsd) blocker = `Leave ${formatUsd(CASH.feeBufferUsd)} for the network fee.`;
  else if (amount > 0 && quote.isSuccess && q === null) blocker = `There’s no market for ${stock.name} right now.`;
  else if (econ && econ.premium > BUY_LIMITS.blockPremium)
    blocker = `Too big for the market right now: you’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. Try a smaller amount.`;
  const warnPremium = econ && econ.premium > BUY_LIMITS.warnPremium && !blocker;
  const feeBlocked = isConnected && fee.state === "unsupported";

  const canReview = amount > 0 && !!q && !blocker && !quote.isFetching;

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={step === "review" ? "Review buy" : `Buy ${stock.name}`}
      onBack={() => (step === "review" && phase === "idle" ? go("amount") : onClose())}
    >
      <SheetSteps stepKey={step} direction={direction} className="flex flex-col gap-3">
        {step === "amount" ? (
          <>
            <div className="flex flex-col gap-2 rounded-2xl border border-ink bg-card p-3.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">You pay</span>
                <span className="flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[13px] bg-chip pl-2 pr-2.5 text-xs font-semibold">
                  <span aria-hidden className="size-[7px] rounded bg-safe" />Cash
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center rounded-[15px] bg-safe text-[15px] font-bold text-white">$</span>
                <label className="num flex flex-1 items-center">
                  <span className="mr-0.5 text-[22px] font-semibold text-subtle">$</span>
                  <span className="sr-only">Amount in dollars</span>
                  <AmountInput
                    autoFocus
                    value={raw}
                    onValue={setRaw}
                    className="text-[30px] font-semibold leading-none tracking-[-0.03em]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setRaw((Math.floor(maxUsd * 100) / 100).toString())}
                  className="flex h-7 items-center rounded-[14px] bg-[rgba(15,14,11,0.06)] px-2.5 text-xs font-semibold text-ink-mid"
                >
                  MAX
                </button>
              </div>
              <span className="text-xs text-subtle">Cash available: {formatUsd(cashUsd)}</span>
            </div>

            <div className="relative z-[1] -my-2.5 flex justify-center">
              <span aria-hidden className="flex size-[34px] items-center justify-center rounded-[17px] border border-[#e3ddcf] bg-ground text-ink">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
              </span>
            </div>

            <div className="flex flex-col gap-2 rounded-2xl border border-[#e3ddcf] bg-card p-3.5">
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">You get (estimated)</span>
              <div className="flex items-center gap-2.5">
                <StockAvatar symbol={stock.symbol} />
                <div className="min-w-0 flex-1">
                  <div className="num text-2xl font-semibold leading-[1.1] tracking-[-0.03em]" aria-live="polite">
                    {quote.isFetching && amount > 0 ? "…" : econ ? econ.shares.toFixed(4) : "0.0000"}
                  </div>
                  <div className="text-xs text-subtle">{ticker}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-subtle">Price</div>
                  <div className="num text-sm font-semibold">{formatUsd(econ ? econ.price : oraclePriceUsd)}</div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-[5px] rounded-[12px] border border-[#e3ddcf] bg-card px-3 py-2.5">
              <Small label="Arrives" value="In seconds" />
              <Small label="Via" value={q ? `${VENUE_LABEL[q.venue]} · fee in the price` : "—"} />
              <Small label="Network fee" value="Paid in USDC" />
            </div>

            {(blocker || warnPremium || closed) && (
              <p role="status" className={`m-0 text-[13px] leading-snug ${blocker ? "text-act" : "text-watch-text"}`}>
                {blocker ??
                  (warnPremium
                    ? `You’d pay ${(econ!.premium * 100).toFixed(1)}% over Aave’s price — the market for ${stock.name} is small.`
                    : "Stock markets are closed. You can still buy, but the price can jump when they reopen.")}
              </p>
            )}

            <button
              type="button"
              disabled={!canReview}
              onClick={() => go("review")}
              className="mt-1 h-[52px] rounded-[26px] bg-ink text-[15px] font-semibold text-on-ink disabled:opacity-45"
              style={{ boxShadow: canReview ? "0 0 0 3px #f4f2ec, 0 0 0 6px #0e0d0b" : undefined }}
            >
              Review buy
            </button>
          </>
        ) : (
          q &&
          econ && (
            <>
              <div className="num rounded-[22px] bg-card px-4 py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
                <Row label="You pay" value={formatUsd(econ.usd)} />
                {fromSavings && <Row label="From savings" value={formatUsd(toUsd(fromSavings.raw))} />}
                <Row label="You get (estimated)" value={`${econ.shares.toFixed(4)} ${ticker}`} />
                <Row label="At least" value={`${(Number(minOut(q.amountOut)) / 10 ** stock.decimals).toFixed(4)} ${ticker}`} />
                <Row label="Price per share" value={formatUsd(econ.price)} />
                <Row label="Aave’s price" value={formatUsd(oraclePriceUsd)} />
                <Row label="Via" value={VENUE_LABEL[q.venue]} />
                <Row label="Network fee" value="Paid in USDC" last />
              </div>
              <p className="m-0 text-xs leading-snug text-subtle">
                {fromSavings ? `You take ${formatUsd(toUsd(fromSavings.raw))} from savings, approve` : "You approve"} exactly{" "}
                {formatUsd(econ.usd)} USDC for the {VENUE_LABEL[q.venue]} router and swap it in one Face ID step. If the
                price moves more than {BUY_LIMITS.slippageBps / 100}%, the buy is cancelled. {stock.name} here is a tokenized
                stock: it tracks the share price; it is not company shares or voting rights.
              </p>
              {feeBlocked && (
                <p role="alert" className="m-0 text-[13px] text-act">
                  Your account can’t pay network fees in USDC on Base right now, so this buy can’t go through.
                </p>
              )}
              <TxError error={error} />
              <FaceIdButton
                label={`Buy ${formatUsd(econ.usd)} with Face ID`}
                phase={phase}
                preview={!isConnected}
                disabled={feeBlocked || fee.loading}
                onClick={() => {
                  if (phase === "failed") reset();
                  void buy({ user, stock, quote: q, cash });
                }}
              />
            </>
          )
        )}
      </SheetSteps>
    </SheetShell>
  );
}

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[12.5px] text-subtle">
      <span>{label}</span>
      <span className="num font-semibold text-ink-2">{value}</span>
    </div>
  );
}

function Row({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-3 text-[15px] ${last ? "" : "border-b border-hairline"}`}>
      <span className="text-ink-mid">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

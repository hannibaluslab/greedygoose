"use client";

import type { ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Button } from "./Button";
import { CASH } from "@/config/risk";
import { formatUsd, formatUsdTrim } from "@/lib/formatting";

const CASH_DOT = "#1f6a4a";
const STOCKS_DOT = "#76b900";

/** Design board "2b · Total balance info" (HomeInfo.dc.html): what the total adds up, and what's left after credit. */
export function TotalBalanceSheet({
  open, onClose, cashUsd, stocksUsd, debtUsd,
}: { open: boolean; onClose: () => void; cashUsd: number; stocksUsd: number; debtUsd: number }) {
  const total = cashUsd + stocksUsd;
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      look="info"
      title="Total balance"
      description="Everything you hold, added up at today’s prices. What you owe on credit is not taken off."
    >
      <SheetSteps stepKey="total" className="num flex flex-col gap-[18px] leading-[normal]">
        <div className="rounded-[22px] bg-card px-4 py-1 shadow-card-elev">
          <Row dot={CASH_DOT} label="Cash" value={formatUsd(cashUsd)} />
          <Row dot={STOCKS_DOT} label="Stocks" value={formatUsd(stocksUsd)} />
          <Total label="Total balance" value={formatUsd(total)} />
        </div>
        {debtUsd > 0 && (
          <div className="rounded-[22px] bg-ink px-4 py-1 text-on-ink">
            <div className="flex items-center justify-between border-b border-[rgba(245,240,226,0.12)] py-3 text-[15px]">
              <span className="text-ink-on-dark-mute">You owe on credit</span>
              <span className="font-medium">−{formatUsd(debtUsd)}</span>
            </div>
            <Total label="After credit" value={<span className="text-brand">{formatUsd(total - debtUsd)}</span>} />
          </div>
        )}
        <Button variant="dark" size="lg" onClick={onClose}>Got it</Button>
      </SheetSteps>
    </SheetShell>
  );
}

/**
 * Design board "2e · Average yield info" (HomeYieldInfo.dc.html), with D19: stocks earn no yield, so the average
 * yield is the cash rate and cash is the only row. Cash is one pot on screen (D20): what it earns in a year counts
 * the part that earns now (savings), and the rest is said in cash terms. While earning runs (`earning`, the Save job),
 * money that just arrived starts earning soon; before it's set up, it isn't earning yet.
 */
export function YieldSheet({
  open, onClose, cashUsd, savingsUsd, apy, earning,
}: { open: boolean; onClose: () => void; cashUsd: number; savingsUsd: number; apy: number; earning: boolean }) {
  const rate = `${(apy * 100).toFixed(1)}%`;
  const value = formatUsdTrim(Math.round(cashUsd));
  const earns = Math.round(savingsUsd * apy);
  const wallet = cashUsd - savingsUsd;
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      look="info"
      title="Average yield"
      description="What your cash earns. Stocks don’t earn a yield, so your average yield is your cash rate."
    >
      <SheetSteps stepKey="yield" className="num flex flex-col gap-[18px] leading-[normal]">
        <div className="rounded-[22px] bg-card px-4 py-1 shadow-card-elev">
          <div className="grid grid-cols-[1fr_auto_52px] gap-3 pb-1 pt-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
            <span>Holding</span>
            <span>Value</span>
            <span className="text-right">APY</span>
          </div>
          <div className="grid grid-cols-[1fr_auto_52px] items-center gap-3 border-b border-hairline py-3 text-[15px]">
            <Dot color={CASH_DOT} label="Cash" />
            <span className="text-ink-mid">{value}</span>
            <span className="text-right font-semibold">{rate}</span>
          </div>
          <div className="grid grid-cols-[1fr_auto_52px] items-center gap-3 py-[13px] text-[16px]">
            <span className="font-semibold">Average yield</span>
            <span className="text-[15px] text-ink-mid">{value}</span>
            <span className="text-right font-bold">{rate}</span>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-[22px] bg-ink px-4 py-1 text-on-ink">
            <Total label="Earns in a year" value={<span className="text-brand">{earns > 0 ? `about ${formatUsdTrim(earns)}` : "Nothing yet"}</span>} />
          </div>
          <p className="m-0 px-0.5 text-[12.5px] leading-[1.45] text-subtle">
            At today’s rate, which moves with the market.
            {wallet > CASH.keepBackUsd &&
              (earning ? ` ${formatUsd(wallet)} arrived recently and starts earning soon.` : ` ${formatUsd(wallet)} of your cash isn’t earning yet.`)}
            {" "}What credit costs isn’t taken off; you see it on your Credit card.
          </p>
        </div>
        <Button variant="dark" size="lg" onClick={onClose}>Got it</Button>
      </SheetSteps>
    </SheetShell>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2 text-ink-mid">
      <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function Row({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
      <Dot color={dot} label={label} />
      <span className="font-medium">{value}</span>
    </div>
  );
}

function Total({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-[13px] text-[16px]">
      <span className="font-semibold">{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

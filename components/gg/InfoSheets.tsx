"use client";

import type { ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { Button } from "./kit/Button";
import { EarnedPeriods, dateText, daysText } from "./home/EarnedPeriods";
import type { TotalEarned } from "@/hooks/useTotalEarned";
import { averageYield, earnedPeriod } from "@/lib/earned";
import { formatUsd, formatUsdTrim } from "@/lib/formatting";
import { leverageOf, leverageText } from "@/lib/leverage";
import { type Status } from "@/lib/risk/status";
import { StatusPill } from "./Status";
import { HealthScore } from "./CreditStatusSheet";

const CASH_DOT = "var(--pos)";
const STOCKS_DOT = "#76b900";

/** Design board "2b · Total balance info" (HomeInfo.dc.html): what the total adds up, and what's left after credit. */
export function TotalBalanceSheet({
  open,
  onClose,
  cashUsd,
  stocksUsd,
  debtUsd,
}: {
  open: boolean;
  onClose: () => void;
  cashUsd: number;
  stocksUsd: number;
  debtUsd: number;
}) {
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
        <Button variant="dark" size="lg" onClick={onClose}>
          Got it
        </Button>
      </SheetSteps>
    </SheetShell>
  );
}

/**
 * Design board "2e · Average yield info" (HomeYieldInfo.dc.html), with D19: stocks earn no yield, so the average
 * yield is the cash rate and cash is the only row. No "Earns in a year" (Adrian, 2026-10-21): what was earned, by
 * period, is the card at the top.
 */
export function YieldSheet({
  open,
  onClose,
  cashUsd,
  savingsUsd,
  apy,
  apr,
  earned,
}: {
  open: boolean;
  onClose: () => void;
  cashUsd: number;
  savingsUsd: number;
  apy: number;
  /** The savings APR, which the live counts run at. */
  apr: number;
  /** What the savings earned (useTotalEarned), for the periods; undefined while it's read. */
  earned: TotalEarned | undefined;
}) {
  const rate = `${(apy * 100).toFixed(1)}%`;
  // Average yield: what the cash really earned since it started earning, as a yearly rate (Adrian, 2026-10-21). Until
  // it has a day to go on, today's rate, and the row says so.
  const all = earned ? earnedPeriod(earned.moves, earned.openUsd, earned.readAt / 1000, null) : null;
  const avg = all ? averageYield(all) : null;
  const avgLine =
    avg !== null && all?.fromSec != null
      ? `over ${daysText(all.days).toLowerCase()} · since ${dateText(all.fromSec)}`
      : "today’s rate";
  const value = formatUsdTrim(Math.round(cashUsd));
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      look="info"
      title="Average yield"
      titleAccessory={
        <span className="flex h-[22px] items-center rounded-[6px] bg-pill px-[7px] font-mono text-[10px] font-medium tracking-[0.04em] text-ink-mid">
          VARIABLE
        </span>
      }
      description="What your cash earns. Stocks don’t earn a yield."
    >
      <SheetSteps stepKey="yield" className="num flex flex-col gap-[18px] leading-[normal]">
        {earned ? (
          <EarnedPeriods earned={earned} savingsUsd={savingsUsd} apr={apr} />
        ) : (
          <div aria-busy className="h-[148px] animate-pulse rounded-[22px] bg-chip" />
        )}
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
            <span className="flex flex-col">
              <span className="font-semibold">Average yield</span>
              <span className="text-[12.5px] text-ink-mid">{avgLine}</span>
            </span>
            <span className="text-[15px] text-ink-mid">{value}</span>
            <span className="text-right font-bold">{avg === null ? rate : `${(avg * 100).toFixed(1)}%`}</span>
          </div>
        </div>
        <Button variant="dark" size="lg" onClick={onClose}>
          Got it
        </Button>
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

/**
 * "Your leverage" (canvas board 13, no greed points): what the 1.7x on Home means, as one division, what you hold ÷
 * what's yours, and the bar of the two: yours, and what runs on credit. Its status pill follows the credit, and the
 * credit's health sits under it, as "My credit status" draws it (Adrian, 2026-10-21).
 */
export function LeverageSheet({
  open,
  onClose,
  holdUsd,
  owedUsd,
  status,
  healthFactor,
}: {
  open: boolean;
  onClose: () => void;
  holdUsd: number;
  owedUsd: number;
  status: Status;
  /** null when nothing is owed. */
  healthFactor: number | null;
}) {
  const x = leverageOf({ holdUsd, owedUsd });
  const yours = Math.max(0, holdUsd - owedUsd);
  const whole = (usd: number) => formatUsdTrim(Math.round(usd));
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      look="info"
      title="My leverage"
      titleAccessory={<StatusPill status={status} size="sm" />}
      description="How much of what you hold runs on credit."
    >
      <SheetSteps stepKey="leverage" className="num flex flex-col gap-[18px] leading-[normal]">
        <div className="flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-card-elev">
          <div
            role="img"
            aria-label={`${whole(holdUsd)} you hold divided by ${whole(yours)} yours equals ${x ? leverageText(x) : "no"} leverage`}
            className="flex items-start justify-between"
          >
            <Term value={whole(holdUsd)} label="you hold" />
            <span aria-hidden className="pt-0.5 text-[20px] text-subtle">
              ÷
            </span>
            <Term value={whole(yours)} label="yours" />
            <span aria-hidden className="pt-0.5 text-[20px] text-subtle">
              =
            </span>
            <span className="flex flex-col items-center gap-0.5">
              <span className="flex h-7 items-center rounded-[14px] bg-ink px-2.5 text-[16px] font-bold text-brand">
                {x ? leverageText(x) : "1.0x"}
              </span>
              <span className="text-[12px] text-ink-mid">leverage</span>
            </span>
          </div>
          <div aria-hidden className="flex h-3 gap-1">
            <span
              className="rounded-md bg-brand shadow-[inset_0_0_0_1px_rgba(14,13,11,0.12)]"
              style={{ flex: yours || 1 }}
            />
            {owedUsd > 0 && <span className="rounded-md bg-ink" style={{ flex: owedUsd }} />}
          </div>
          <div className="flex justify-between text-[13px] text-ink-2">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-brand shadow-[inset_0_0_0_1px_rgba(14,13,11,0.2)]" />
              Yours <b className="font-semibold text-ink">{whole(yours)}</b>
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-ink" />
              On credit <b className="font-semibold text-ink">{whole(owedUsd)}</b>
            </span>
          </div>
        </div>
        {owedUsd > 0 && healthFactor !== null && (
          <div className="flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-card-elev">
            <HealthScore health={healthFactor} status={status} />
          </div>
        )}
        <Button variant="dark" onClick={onClose} className="w-full">
          Got it
        </Button>
      </SheetSteps>
    </SheetShell>
  );
}

function Term({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span className="text-[22px] font-semibold tracking-[-0.02em]">{value}</span>
      <span className="text-[12px] text-ink-mid">{label}</span>
    </span>
  );
}

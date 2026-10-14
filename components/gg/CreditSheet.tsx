"use client";

import Link from "next/link";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { ChevronRight, ShieldIcon, SlidersIcon } from "./icons";
import { StatusBar, StatusPill } from "./Status";
import type { PositionData } from "@/hooks/usePosition";
import type { GuardianStatus } from "@/hooks/useGuardian";
import { formatUsd } from "@/lib/formatting";

/** Design board "2c · Credit sheet" (HomeCreditSlide.dc.html). */
export function CreditSheet({ open, data, onClose, guardian }: { open: boolean; data: PositionData; onClose: () => void; guardian: GuardianStatus }) {
  const limit = data.debtUsd + data.availableUsd;
  const usedPct = limit > 0 ? Math.min(100, (data.debtUsd / limit) * 100) : 0;

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Credit"
      headerRight={
        <Link href="/credit" aria-label="Credit details" className="flex size-8 items-center justify-center rounded-full bg-chip">
          <SlidersIcon size={16} />
        </Link>
      }
    >
      <SheetSteps stepKey="credit" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-4 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          <div className="flex items-center justify-between">
            <div className="num flex items-baseline gap-1.5">
              <span className="text-[38px] font-semibold leading-none tracking-[-0.04em]">{formatUsd(data.debtUsd)}</span>
              <span className="text-sm text-subtle">owed</span>
            </div>
            <StatusPill status={data.status} />
          </div>
          <StatusBar status={data.status} healthFactor={data.healthFactor} />
        </div>

        <div className="num rounded-[22px] bg-card px-4 py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          <div className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
            <span className="text-ink-mid">Cost</span>
            <span className="font-semibold">{formatUsd(data.monthlyCostUsd)} / month</span>
          </div>
          <div className="flex flex-col gap-2 border-b border-hairline py-3">
            <div className="flex justify-between text-[15px]">
              <span className="text-ink-mid">Credit available</span>
              <span className="font-semibold">{formatUsd(data.availableUsd)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-[3px] bg-[rgba(14,13,11,0.08)]">
              <div className="h-1.5 rounded-[3px] bg-ink" style={{ width: `${usedPct}%` }} />
            </div>
            <div className="flex justify-between text-xs text-subtle">
              <span>Used {formatUsd(data.debtUsd)}</span>
              <span>Room {formatUsd(data.availableUsd)}</span>
            </div>
          </div>
          <div className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
            <span className="text-ink-mid">Borrow rate</span>
            <span className="font-semibold">{(data.apr * 100).toFixed(2)}% a year</span>
          </div>
          <Link href="/guardian" className="flex items-center justify-between py-3 text-[15px] no-underline">
            <span className="flex items-center gap-2 text-ink-mid">
              <span aria-hidden className="flex size-[22px] items-center justify-center rounded-[11px] bg-brand text-ink">
                <ShieldIcon />
              </span>
              Guardian
            </span>
            <span className="flex items-center gap-1 font-semibold">
              {guardian === "on" ? "On" : guardian === "unconfigured" ? "Soon" : "Set up"}
              <ChevronRight className="text-subtle" />
            </span>
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <Link href="/loan" className="flex h-[52px] items-center justify-center rounded-[26px] bg-chip text-[15px] font-semibold text-ink no-underline">
            Get a loan
          </Link>
          <Link
            href="/repay"
            className="flex h-[52px] items-center justify-center rounded-[26px] bg-brand text-[15px] font-bold text-ink no-underline"
            style={{ boxShadow: "0 0 14px rgba(212,255,60,0.32)" }}
          >
            Repay
          </Link>
        </div>
      </SheetSteps>
    </SheetShell>
  );
}

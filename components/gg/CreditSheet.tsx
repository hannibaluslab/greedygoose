"use client";

import { Sheet } from "./Sheet";
import Link from "next/link";
import { ChevronRight, ShieldIcon, SlidersIcon } from "./icons";
import { StatusBar, StatusPill } from "./Status";
import type { PositionData } from "@/hooks/usePosition";
import { formatUsd } from "@/lib/formatting";

/** Design board "2c · Credit sheet" (HomeCreditSlide.dc.html). */
export function CreditSheet({ data, onClose }: { data: PositionData; onClose: () => void }) {

  const limit = data.debtUsd + data.availableUsd;
  const usedPct = limit > 0 ? Math.min(100, (data.debtUsd / limit) * 100) : 0;

  return (
    <Sheet label={"Credit"} onClose={onClose}>
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-2xl font-semibold tracking-[-0.02em]">Credit</h2>
          <Link href="/credit" aria-label="Credit details" className="-mr-1.5 flex size-10 items-center justify-center rounded-[20px] bg-chip">
            <SlidersIcon />
          </Link>
        </div>

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
            <span className="text-muted">Cost</span>
            <span className="font-semibold">{formatUsd(data.monthlyCostUsd)} / month</span>
          </div>
          <div className="flex flex-col gap-2 border-b border-hairline py-3">
            <div className="flex justify-between text-[15px]">
              <span className="text-muted">Credit available</span>
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
          <Link href="/credit" className="flex items-center justify-between py-3 text-[15px] no-underline">
            <span className="flex items-center gap-2 text-muted">
              <span aria-hidden className="flex size-[22px] items-center justify-center rounded-[11px] bg-accent text-ink">
                <ShieldIcon />
              </span>
              Borrow rate
            </span>
            <span className="flex items-center gap-1 font-semibold">
              {(data.apr * 100).toFixed(2)}% a year
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
            className="flex h-[52px] items-center justify-center rounded-[26px] bg-accent text-[15px] font-bold text-ink no-underline"
            style={{ boxShadow: "0 0 14px rgba(212,255,60,0.32)" }}
          >
            Repay
          </Link>
        </div>
    </Sheet>
  );
}

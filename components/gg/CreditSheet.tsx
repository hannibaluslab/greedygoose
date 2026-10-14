"use client";

import Link from "next/link";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Button } from "./Button";
import { ChevronRight, ShieldIcon, SlidersIcon } from "./icons";
import { StatusBar, StatusPill } from "./Status";
import type { PositionData } from "@/hooks/usePosition";
import { useAgents } from "@/hooks/useAgents";
import type { AgentStatus } from "@/lib/agents/status";
import { toUsd } from "@/lib/cash";
import { formatUsdTrim } from "@/lib/formatting";

const PROTECT: Record<Exclude<AgentStatus, "on">, string> = {
  unconfigured: "Not live yet",
  loading: "…",
  off: "Off",
  starting: "Starting",
};

/**
 * Design board "2c · Credit sheet" (HomeCreditSlide.dc.html). Protection is the Cash Agent's Protect job. The rate
 * sits under the cost (CLAUDE.md: always show the rate and the monthly cost).
 */
export function CreditSheet({ open, address, data, onClose }: { open: boolean; address: `0x${string}`; data: PositionData; onClose: () => void }) {
  const agents = useAgents(address);
  const limit = data.debtUsd + data.availableUsd;
  const usedPct = limit > 0 ? Math.min(100, (data.debtUsd / limit) * 100) : 0;
  // Rounded up, as on Home's Credit card: what's owed is never shown as less than it is.
  const owed = formatUsdTrim(Math.ceil(data.debtUsd));
  const protect =
    agents.status.protect === "on" ? `Up to ${formatUsdTrim(toUsd(agents.capRaw.protect!))} a day` : PROTECT[agents.status.protect];

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Credit"
      look="info"
      headerRight={
        <Link href="/credit" aria-label="Credit details" className="-mr-1.5 flex size-10 items-center justify-center rounded-[20px] bg-chip">
          <SlidersIcon strokeWidth={2} />
        </Link>
      }
    >
      <SheetSteps stepKey="credit" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-4 shadow-card-elev">
          <div className="flex items-center justify-between">
            <div className="num flex items-baseline gap-1.5">
              <span className="text-[38px] font-semibold leading-none tracking-[-0.04em]">{owed}</span>
              <span className="text-sm text-subtle">owed</span>
            </div>
            <StatusPill status={data.status} />
          </div>
          <StatusBar status={data.status} healthFactor={data.healthFactor} />
        </div>

        <div className="num rounded-[22px] bg-card px-4 py-0.5 leading-[normal] shadow-card-elev">
          <div className="flex flex-col gap-1 border-b border-hairline py-3">
            <div className="flex items-center justify-between text-[15px]">
              <span className="text-ink-mid">Cost</span>
              <span className="font-semibold">{formatUsdTrim(data.monthlyCostUsd)} / month</span>
            </div>
            <span className="text-xs text-subtle">{(data.apr * 100).toFixed(2)}% a year, variable</span>
          </div>
          <div className="flex flex-col gap-2 border-b border-hairline py-3">
            <div className="flex justify-between text-[15px]">
              <span className="text-ink-mid">Credit available</span>
              <span className="font-semibold">{formatUsdTrim(data.availableUsd)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-[3px] bg-[rgba(14,13,11,0.08)]">
              <div className="h-1.5 rounded-[3px] bg-ink" style={{ width: `${usedPct}%` }} />
            </div>
            <div className="flex justify-between text-xs text-subtle">
              <span>Used {owed}</span>
              <span>Room {formatUsdTrim(data.availableUsd)}</span>
            </div>
          </div>
          <Link href="/agents" className="flex items-center justify-between py-3 text-[15px] no-underline">
            <span className="flex items-center gap-2 text-ink-mid">
              <span aria-hidden className="flex size-[22px] items-center justify-center rounded-[11px] bg-brand text-ink">
                <ShieldIcon />
              </span>
              Protection
            </span>
            <span className="flex items-center gap-1 font-semibold">
              {protect}
              <ChevronRight className="text-subtle" />
            </span>
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <Button variant="soft" href="/buy">Buy more</Button>
          <Button href="/repay" disabled={data.debtUsd <= 0}>Repay</Button>
        </div>
      </SheetSteps>
    </SheetShell>
  );
}

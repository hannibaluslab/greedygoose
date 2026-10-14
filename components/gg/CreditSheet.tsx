"use client";

import Link from "next/link";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Button } from "./Button";
import { ChevronRight, ShieldIcon, SlidersIcon } from "./icons";
import { StatusBar, StatusPill } from "./Status";
import { Switch } from "./Switch";
import type { PositionData } from "@/hooks/usePosition";
import { useAgents } from "@/hooks/useAgents";
import { useCreditForBuying } from "@/hooks/useCreditForBuying";
import type { AgentStatus } from "@/lib/agents/status";
import { homeStatus } from "@/lib/risk/status";
import { USDC } from "@/lib/tokens/registry";
import { formatUsdTrim } from "@/lib/formatting";

/** The Protect row: the Protect job, and its daily limit once it runs. */
function protection(status: AgentStatus, capRaw: bigint | null) {
  if (status === "on" && capRaw !== null) return `Up to ${formatUsdTrim(Number(capRaw) / 10 ** USDC.decimals)} a day`;
  return { unconfigured: "Not live yet", loading: "…", off: "Off", starting: "Starting", on: "On" }[status];
}

/**
 * Design board "2c · Credit sheet" (HomeCreditSlide.dc.html). The rate sits under the cost (CLAUDE.md: always show
 * the rate and the monthly cost); the settings button and the Protection row open Manage's Credit tab (ManageCredit).
 */
export function CreditSheet({
  open, account, data, onClose, onBuyMore,
}: {
  open: boolean;
  account: `0x${string}`;
  data: PositionData;
  onClose: () => void;
  /** Where "Buy more" goes when the Market is on the same page (Invest); the Market at /buy otherwise. */
  onBuyMore?: () => void;
}) {
  const agents = useAgents(account);
  const [creditForBuying, setCreditForBuying] = useCreditForBuying(account);
  const limit = data.debtUsd + data.availableUsd;
  const usedPct = limit > 0 ? Math.min(100, (data.debtUsd / limit) * 100) : 0;
  const status = homeStatus(data.status);
  // Rounded up, as on Home's Credit card: what's owed is never shown as less than it is.
  const owed = formatUsdTrim(Math.ceil(data.debtUsd));

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      look="info"
      title="Credit"
      headerRight={
        <Link href="/manage/credit" aria-label="Credit settings" className="-mr-1.5 flex size-10 items-center justify-center rounded-full bg-pill text-ink">
          <SlidersIcon strokeWidth={2} />
        </Link>
      }
    >
      <SheetSteps stepKey="credit" className="num flex flex-col gap-4 leading-[normal]">
        <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-4 shadow-card-elev">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[38px] font-semibold leading-none tracking-[-0.04em]">{owed}</span>
              <span className="text-sm text-subtle">owed</span>
            </div>
            <StatusPill status={status} />
          </div>
          <StatusBar status={status} healthFactor={data.healthFactor} />
        </div>

        <div className="rounded-[22px] bg-card px-4 py-0.5 shadow-card-elev">
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
          <Link href="/manage/credit" className="flex items-center justify-between py-3 text-[15px] text-ink no-underline">
            <span className="flex items-center gap-2 text-ink-mid">
              <span aria-hidden className="flex size-[22px] items-center justify-center rounded-[11px] bg-brand text-ink">
                <ShieldIcon />
              </span>
              Protect
            </span>
            <span className="flex items-center gap-1 font-semibold">
              {protection(agents.status.protect, agents.terms.protect?.capRaw ?? null)}
              <ChevronRight className="text-subtle" />
            </span>
          </Link>
          <div className="flex items-center gap-3 border-t border-hairline py-3">
            <span className="flex grow flex-col gap-0.5">
              <span className="text-[15px] text-ink-mid">Use credit for buying</span>
              <span className="text-xs text-subtle">Only when a buy is bigger than your cash</span>
            </span>
            <Switch label="Use credit for buying" checked={creditForBuying} onChange={setCreditForBuying} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <Button variant="soft" href={onBuyMore ? undefined : "/buy"} onClick={onBuyMore}>Buy more</Button>
          <Button href="/repay" disabled={data.debtUsd <= 0}>Repay</Button>
        </div>
      </SheetSteps>
    </SheetShell>
  );
}

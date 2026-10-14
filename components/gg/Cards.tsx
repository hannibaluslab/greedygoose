import { MoneyCompact } from "./Money";
import { StatusPill } from "./Status";
import { Tap } from "./Tap";
import { ChevronRight, TrendUpIcon } from "./icons";
import type { Status } from "@/lib/risk/status";
import { formatUsdTrim } from "@/lib/formatting";

const CARD = "flex flex-col gap-2 rounded-[22px] px-4 py-3.5 leading-[normal]";

/**
 * The dark Cash card on Home (HomeUpliftRail): cash is savings plus wallet USDC (D15), with the
 * savings rate as a lime chip. `apy` is a yearly yield as a fraction (0.042); no chip until it's known.
 */
export function CashCard({
  cashUsd, apy, note, href, onClick,
}: { cashUsd: number; apy?: number | null; note?: string; href?: string; onClick?: () => void }) {
  return (
    <Tap href={href} onClick={onClick} className={`${CARD} bg-ink text-left text-on-ink shadow-[0_16px_32px_-18px_rgba(0,0,0,0.5)]`}>
      <span className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">Cash</span>
        {apy != null && (
          <span className="flex h-[22px] items-center gap-1 rounded-[6px] bg-[rgba(212,255,60,0.14)] px-[7px] font-mono text-[10px] font-medium tracking-[0.04em] text-brand">
            <TrendUpIcon />
            {(apy * 100).toFixed(1)}% APY
          </span>
        )}
      </span>
      <MoneyCompact value={cashUsd} size={26} centsSize={15} centsClass="text-ink-on-dark-mute" lineHeight="normal" />
      <span className="-mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-on-dark-mute">
        <span className="font-mono text-[10px] tracking-[0.04em]">USDC</span>
        {note && (
          <>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-0.5">
              {note}
              {(href || onClick) && <ChevronRight size={12} strokeWidth={2.2} />}
            </span>
          </>
        )}
      </span>
    </Tap>
  );
}

/** The Credit card next to Cash (HomeUpliftRail): what's owed, the status pill and the monthly cost. */
export function CreditCard({
  debtUsd, status, monthlyCostUsd, href, onClick,
}: { debtUsd: number; status: Status; monthlyCostUsd: number; href?: string; onClick?: () => void }) {
  return (
    <Tap href={href} onClick={onClick} className={`${CARD} bg-card text-left text-ink shadow-card-elev`}>
      <span className="flex w-full items-center justify-between">
        <span className="text-[14px] font-semibold">Credit</span>
        <StatusPill status={status} size="sm" />
      </span>
      {/* Rounded up: what's owed is never shown as less than it is. */}
      <span className="flex items-baseline gap-1.5">
        <span className="num text-[26px] font-semibold tracking-[-0.03em]">{formatUsdTrim(Math.ceil(debtUsd))}</span>
        <span className="text-[13px] text-subtle">owed</span>
      </span>
      <span className="mt-auto flex w-full items-baseline justify-between text-[12px]">
        <span className="text-subtle">Cost</span>
        <span className="num font-semibold">{formatUsdTrim(monthlyCostUsd)} / month</span>
      </span>
    </Tap>
  );
}

import { MoneyCompact } from "./Money";
import { StatusPill } from "./Status";
import { Tap } from "./Tap";
import { ChevronRight } from "./icons";
import type { Status } from "@/lib/risk/status";
import { formatUsdTrim, monthlyCostText } from "@/lib/formatting";

const CARD = "flex flex-col gap-2 rounded-[22px] px-4 py-3.5 leading-[normal]";

/**
 * The dark Cash card on Home (board 2f): cash is savings plus wallet USDC (D15), with a USDC chip and one line under
 * it: "Always earning", or "Not earning yet" before the Save grant; `note` ("120 USDT arriving") takes the line's
 * place. `dim`: board 2g, money is in but earning isn't on yet, so the card sits at 60% with no shadow.
 */
export function CashCard({
  cashUsd, earning, note, dim = false, href, onClick,
}: { cashUsd: number; earning: boolean; note?: string; dim?: boolean; href?: string; onClick?: () => void }) {
  return (
    <Tap
      href={href}
      onClick={onClick}
      className={`${CARD} bg-ink text-left text-on-ink ${dim ? "opacity-60" : "shadow-[0_16px_32px_-18px_rgba(0,0,0,0.5)]"}`}
    >
      <span className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">Cash</span>
        <span className="flex h-[22px] items-center rounded-[6px] bg-[rgba(212,255,60,0.14)] px-[7px] font-mono text-[10px] font-medium tracking-[0.04em] text-brand">
          USDC
        </span>
      </span>
      <MoneyCompact value={cashUsd} size={26} centsSize={15} centsClass="text-ink-on-dark-mute" lineHeight="normal" />
      <span className="-mt-1 flex items-center gap-0.5 text-[11px] text-ink-on-dark-mute">
        {note ?? (earning ? "Always earning" : "Not earning yet")}
        {note && (href || onClick) && <ChevronRight size={12} strokeWidth={2.2} />}
      </span>
    </Tap>
  );
}

/**
 * The white Yield card next to Cash (board 2f): the cash rate (D19: stocks earn no yield, so it's the one rate) with a
 * VARIABLE chip. "Earned so far" joins it once it's read from the chain; never estimated from the rate.
 */
export function YieldCard({ apy, dim = false, href, onClick }: { apy: number | null; dim?: boolean; href?: string; onClick?: () => void }) {
  return (
    <Tap href={href} onClick={onClick} className={`${CARD} bg-card text-left text-ink shadow-card-elev ${dim ? "opacity-60" : ""}`}>
      <span className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">Yield</span>
        <span className="flex h-[22px] items-center rounded-[6px] bg-pill px-[7px] font-mono text-[10px] font-medium tracking-[0.04em] text-ink-mid">
          VARIABLE
        </span>
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="num text-[26px] font-semibold tracking-[-0.03em]">{apy == null ? "–" : `${(apy * 100).toFixed(1)}%`}</span>
        <span className="text-[13px] text-subtle">APY</span>
      </span>
    </Tap>
  );
}

/**
 * The Credit card next to Cash (HomeUpliftRail): what's owed, the status pill and the monthly cost. With nothing
 * owed, the credit available takes the cost's place (F2-1), rounded down so it's never shown as more than it is.
 */
export function CreditCard({
  debtUsd, status, monthlyCostUsd, availableUsd, href, onClick,
}: { debtUsd: number; status: Status; monthlyCostUsd: number; availableUsd: number; href?: string; onClick?: () => void }) {
  const owes = debtUsd > 0;
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
        <span className="text-subtle">{owes ? "Cost" : "Available"}</span>
        <span className="num font-semibold">{owes ? monthlyCostText(monthlyCostUsd) : formatUsdTrim(Math.floor(availableUsd))}</span>
      </span>
    </Tap>
  );
}

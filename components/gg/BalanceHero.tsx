import type { ReactNode } from "react";
import { InfoIcon } from "./icons";
import { Money } from "./Money";
import { formatSignedPct, formatSignedUsd } from "@/lib/formatting";

type Info = { label: string; onClick: () => void };
type Column = { label: string; info?: Info; sub?: ReactNode };

/**
 * The balance block at the top of Home and Invest (HomeUpliftRail, PortfolioPage): the big
 * "$5,000.00" on the left, a second figure on the right of a hairline, a line under each.
 */
export function BalanceHero({
  label, info, value, sub, side,
}: Column & { value: number; side: Column & { value: ReactNode; unit?: string } }) {
  return (
    <div className="num grid grid-cols-[auto_1fr] items-baseline px-[16.75px] leading-[normal]">
      <div className="flex items-center gap-1.5 pb-1">
        <span className="label">{label}</span>
        {info && <InfoButton {...info} />}
      </div>
      <Divided className="flex items-center justify-center gap-1.5 whitespace-nowrap pb-1">
        <span className="label">{side.label}</span>
        {side.info && <InfoButton {...side.info} />}
      </Divided>

      <Money value={value} size={46} dollarSize={22} centsSize={19} />
      <Divided className="flex items-baseline justify-center gap-1 self-stretch">
        <span className="text-[30px] font-semibold leading-none tracking-[-0.03em]">{side.value}</span>
        {side.unit && <span className="text-[13px] font-medium text-subtle">{side.unit}</span>}
      </Divided>

      {(sub || side.sub) && (
        <>
          <div className="pt-[5px] text-[13px] text-ink-mid">{sub}</div>
          <Divided className="whitespace-nowrap pt-[5px] text-[13px] text-ink-mid">{side.sub}</Divided>
        </>
      )}
    </div>
  );
}

/** "+$38.20 · +0.76% today", green up and red down. */
export function TodayChange({ usd, pct }: { usd: number; pct: number }) {
  const money = formatSignedUsd(usd);
  const tone = money.startsWith("−") ? "text-neg" : "text-pos";
  return (
    <>
      <span className={`font-semibold ${tone}`}>{money}</span> · <span className={`font-semibold ${tone}`}>{formatSignedPct(pct)}</span> today
    </>
  );
}

function Divided({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ml-[18px] border-l border-line-mid pl-[18px] text-center ${className}`}>{children}</div>;
}

function InfoButton({ label, onClick }: Info) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="-m-1 flex size-6 items-center justify-center text-subtle">
      <InfoIcon />
    </button>
  );
}

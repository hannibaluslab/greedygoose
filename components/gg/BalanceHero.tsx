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
  const k = fit(value);
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

      <Money value={value} size={46 * k} dollarSize={22 * k} centsSize={19 * k} />
      {/* 8px under its label (Adrian: not tight under it, not down on the big figure's foot); stretched so the
          hairline runs on. */}
      <Divided className="flex items-start justify-center self-stretch pt-2">
        <span className="flex items-baseline gap-1">
          <span className="text-[30px] font-semibold leading-none tracking-[-0.03em]">{side.value}</span>
          {side.unit && <span className="text-[13px] font-medium text-subtle">{side.unit}</span>}
        </span>
      </Divided>

      {(sub || side.sub) && (
        <>
          <div className="pt-[5px] text-[13px] text-ink-mid">{sub}</div>
          {/* Stretched when empty, so the hairline still runs down beside the line under the big figure. */}
          <Divided className={`whitespace-nowrap pt-[5px] text-[13px] text-ink-mid ${side.sub ? "" : "self-stretch"}`}>{side.sub}</Divided>
        </>
      )}
    </div>
  );
}

/**
 * The board's "$5,000.00" fills the left column exactly (157px at 46px), and "Average yield" with its info dot
 * fills the right one. Each extra digit adds 27px and each extra comma 8px, so a longer total shrinks by that much
 * and the right column keeps its room.
 */
function fit(value: number) {
  // Rounded to the cent first, as Money draws it.
  const int = Number(Math.abs(value).toFixed(2).split(".")[0]).toLocaleString("en-US");
  const digits = int.replace(/,/g, "").length;
  const width = 157 + 27 * (digits - 4) + 8 * (int.length - digits - 1);
  return Math.min(1, 157 / width);
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

/** TodayChange's place while market prices load. */
export function TodayPending() {
  return <span aria-hidden className="inline-block h-[13px] w-[150px] animate-pulse rounded-full bg-chip align-[-2px]" />;
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

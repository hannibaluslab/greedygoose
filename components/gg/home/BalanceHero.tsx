"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Money } from "../kit/Money";
import { formatSignedPct, formatSignedUsd } from "@/lib/formatting";

type Column = { label: string; sub?: ReactNode };
type Opens = { label: string; run: () => void };

/**
 * The balance block at the top of Home and Invest (HomeUpliftRail, PortfolioPage): the big
 * "$5,000.00" on the left, a second figure on the right of a hairline, a line under each. `onOpen`: the whole left
 * column (its label, figure and line) is one tap that opens what's in it (Home: Total balance, Adrian 2026-10-21, in
 * place of the ⓘ beside it).
 */
export function BalanceHero({
  label,
  onOpen,
  value,
  sub,
  side,
  even = false,
}: Column & {
  onOpen?: Opens;
  value: number;
  /** `onClick`: the figure and its unit open something (Home: the owed amount opens the Credit sheet). */
  side: Column & { value: ReactNode; unit?: string; onClick?: Opens };
  /** Two equal columns, not the figure's own width (Invest). */ even?: boolean;
}) {
  const rows = sub || side.sub ? 3 : 2;
  return (
    <div
      className={`num relative grid ${even ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[157px_1fr]"} ${rows === 3 ? "grid-rows-[auto_auto_auto]" : "grid-rows-[auto_auto]"} items-baseline px-[16.75px] leading-[normal]`}
    >
      {/* The left column never grows (Adrian, 2026-10-18): a total that doesn't fit gets smaller instead. */}
      <div className="flex items-center gap-1.5 whitespace-nowrap pb-1">
        <span className="label">{label}</span>
      </div>
      <Divided className="flex items-center justify-center gap-1.5 whitespace-nowrap pb-1">
        <span className="label">{side.label}</span>
      </Divided>

      {even ? <ScaledMoney value={value} k={fit(value)} /> : <FitMoney value={value} />}
      {/* 8px under its label (Adrian: not tight under it, not down on the big figure's foot); stretched so the
          hairline runs on. Smaller when it wouldn't fit its column (cents on what's owed, Adrian 2026-10-21). */}
      <Divided className="min-w-0 self-stretch pt-2">
        {side.onClick ? (
          <button
            type="button"
            aria-label={side.onClick.label}
            onClick={side.onClick.run}
            className="block w-full text-ink"
          >
            <FitLine align="center">
              <SideFigure side={side} />
            </FitLine>
          </button>
        ) : (
          <FitLine align="center">
            <SideFigure side={side} />
          </FitLine>
        )}
      </Divided>

      {(sub || side.sub) && (
        <>
          {/* Each line under a figure stays on one line (Adrian): smaller when it wouldn't fit, never two lines. */}
          <div className="min-w-0 pt-[5px] text-[13px] text-ink-mid">
            <FitLine align="start">{sub}</FitLine>
          </div>
          {/* Stretched when empty, so the hairline still runs down beside the line under the big figure. */}
          <Divided className={`min-w-0 pt-[5px] text-[13px] text-ink-mid ${side.sub ? "" : "self-stretch"}`}>
            {side.sub && <FitLine align="center">{side.sub}</FitLine>}
          </Divided>
        </>
      )}
      {/* Over the left column's cells, out of the grid's flow (absolute), so nothing moves. */}
      {onOpen && (
        <button
          type="button"
          aria-label={onOpen.label}
          onClick={onOpen.run}
          // Both lines set: an absolute item's open end would run to the grid's edge, over Credit.
          style={{ gridColumn: "1 / 2", gridRow: `1 / ${rows + 1}` }}
          className="absolute -inset-x-2 -inset-y-1 rounded-[14px] transition-colors active:bg-ink/5"
        />
      )}
    </div>
  );
}

/**
 * One line that never wraps: drawn at full size when it fits its column, else zoomed down to the column's width. Its
 * width is measured at full size on an invisible copy, as FitMoney does, and again whenever the column resizes.
 */
function FitLine({ children, align }: { children: ReactNode; align: "start" | "center" }) {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const measure = () => {
      const room = box.current?.clientWidth;
      const need = probe.current?.getBoundingClientRect().width;
      if (!room || !need) return;
      const next = Math.min(1, room / need);
      setK((k) => (Math.abs(k - next) > 0.005 ? next : k));
    };
    measure();
    const seen = new ResizeObserver(measure);
    if (box.current) seen.observe(box.current);
    if (probe.current) seen.observe(probe.current);
    return () => seen.disconnect();
  }, []);
  return (
    <div ref={box} className={`relative flex min-w-0 ${align === "center" ? "justify-center" : "justify-start"}`}>
      {/* Clipped, so the full-size copy never widens the page (it measured past a 375px screen with cents owed). */}
      <span aria-hidden className="pointer-events-none invisible absolute inset-0 overflow-hidden">
        <span ref={probe} className="absolute left-0 top-0 inline-block whitespace-nowrap">
          {children}
        </span>
      </span>
      <span className="inline-block whitespace-nowrap" style={k < 1 ? { zoom: k } : undefined}>
        {children}
      </span>
    </div>
  );
}

/** The right column's figure and its unit ("$600 owed"). */
const SideFigure = ({ side }: { side: { value: ReactNode; unit?: string } }) => (
  <span className="flex items-baseline gap-1">
    <span className="text-[30px] font-semibold leading-none tracking-[-0.03em]">{side.value}</span>
    {side.unit && <span className="text-[13px] font-medium text-subtle">{side.unit}</span>}
  </span>
);

const ScaledMoney = ({ value, k }: { value: number; k: number }) => (
  <Money value={value} size={46 * k} dollarSize={22 * k} centsSize={19 * k} />
);

/** The hero's left column: the board's "$5,000.00" at 46px. */
const HERO_PX = 157;

/**
 * The total, as big as the board draws it, and smaller when it wouldn't fit the left column: its width is measured at
 * full size (an invisible copy), so the figure shrinks to the column, the column never grows and Credit keeps its room.
 */
function FitMoney({ value }: { value: number }) {
  const probe = useRef<HTMLSpanElement>(null);
  const [k, setK] = useState(() => fit(value));
  useLayoutEffect(() => {
    const measure = () => {
      const w = probe.current?.getBoundingClientRect().width;
      if (w) setK(Math.min(1, HERO_PX / w));
    };
    measure();
    void document.fonts?.ready.then(measure);
  }, [value]);
  return (
    <span className="relative block min-w-0">
      <span ref={probe} aria-hidden className="invisible absolute left-0 top-0 whitespace-nowrap">
        <ScaledMoney value={value} k={1} />
      </span>
      <ScaledMoney value={value} k={k} />
    </span>
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
  // No move is neither green nor red, and carries no sign: "$0.00 · 0.00% today".
  const still = Math.abs(usd) < 0.005;
  const money = still ? "$0.00" : formatSignedUsd(usd);
  const tone = still ? "" : money.startsWith("−") ? "text-neg" : "text-pos";
  return (
    <>
      <span className={`font-semibold ${tone}`}>{money}</span> ·{" "}
      <span className={`font-semibold ${tone}`}>{still ? "0.00%" : formatSignedPct(pct)}</span> today
    </>
  );
}

/** All-time P&L under the total balance (Adrian, 2026-10-19): "+$142.84 · +7.14% all time". */
export function AllTimeChange({ usd, pct }: { usd: number; pct: number | null }) {
  const still = Math.abs(usd) < 0.005;
  const money = still ? "$0.00" : formatSignedUsd(usd);
  const tone = still ? "" : money.startsWith("−") ? "text-neg" : "text-pos";
  return (
    <>
      <span className={`font-semibold ${tone}`}>{money}</span>
      {pct !== null && (
        <>
          {" "}
          · <span className={`font-semibold ${tone}`}>{still ? "0.00%" : formatSignedPct(pct)}</span>
        </>
      )}{" "}
      all time
    </>
  );
}

/** TodayChange's place while market prices load. */
export function TodayPending() {
  return (
    <span aria-hidden className="inline-block h-[13px] w-[150px] animate-pulse rounded-full bg-chip align-[-2px]" />
  );
}

function Divided({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ml-[18px] border-l border-line-mid pl-[18px] text-center ${className}`}>{children}</div>;
}

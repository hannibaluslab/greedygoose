"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { AmountInput } from "./AmountInput";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { CreditIcon, TradeIcon } from "./icons";
import { CashMark } from "./AssetPicker";
import { formatUsd } from "@/lib/formatting";

/**
 * Size ladder from NYM's amount field: the number steps down as it lengthens so it never runs
 * under MAX. The floor is 16px, the size below which iOS zooms the page on focus.
 */
export function amountFontSize(value: string): number {
  const len = Math.max(1, value.length);
  return len <= 6 ? 30 : len <= 8 ? 26 : len <= 10 ? 22 : len <= 12 ? 19 : 16;
}

/**
 * The canvas amount card (F1-4, F2-5): label with the money's source on the right, a round badge,
 * "$" + amount, optional MAX, a hint under it. With `unit`, an amount of shares: the ticker after
 * the number instead of the "$" before it (the stock sheet's sell step).
 */
export function AmountField({
  label, source, badge, unit, value, onValue, decimals, onMax, hint, ...rest
}: {
  label?: string;
  /** Where the money comes from, top right: an `AmountSource` pill ("Cash", "Against NVIDIA"). */
  source?: ReactNode;
  /** The 30px round mark before the amount: an `AmountBadge`, or the stock's badge for shares. */
  badge?: ReactNode;
  /** Shares of this ticker rather than dollars. */
  unit?: string;
  onMax?: () => void;
  hint?: ReactNode;
} & Omit<ComponentProps<typeof AmountInput>, "id" | "style" | "className">) {
  const id = useId();
  const size = amountFontSize(value);
  return (
    <div className="flex flex-col gap-2 rounded-[16px] border border-line-field bg-card p-3.5 leading-[normal] focus-within:border-ink">
      {(label || source) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label htmlFor={id} className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
              {label}
            </label>
          )}
          {source}
        </div>
      )}
      {/* Fixed height: the card stays put while the number steps down. */}
      <div className="flex h-[30px] items-center gap-2.5">
        {badge}
        <div className="num flex min-w-0 flex-1 items-center font-semibold">
          {!unit && (
            <span aria-hidden className="mr-0.5 text-subtle transition-[font-size] duration-150 ease-out" style={{ fontSize: Math.round(size * 0.72) }}>
              $
            </span>
          )}
          <AmountInput
            id={id}
            value={value}
            onValue={onValue}
            decimals={decimals}
            aria-describedby={hint ? `${id}-hint` : undefined}
            className="leading-none tracking-[-0.03em] transition-[font-size] duration-150 ease-out"
            style={{ fontSize: size }}
            {...rest}
          />
          {unit && <span className="ml-1 shrink-0 text-sm font-semibold text-subtle">{unit}</span>}
        </div>
        {/* MAX follows the field: while it's disabled (a send or trade in flight), so is MAX. */}
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            disabled={rest.disabled}
            className="h-7 shrink-0 rounded-[14px] bg-[rgba(15,14,11,0.06)] px-2.5 text-xs font-semibold text-ink-mid disabled:opacity-45"
          >
            MAX
          </button>
        )}
      </div>
      {hint && (
        <span id={`${id}-hint`} className="text-[12px] text-subtle">
          {hint}
        </span>
      )}
    </div>
  );
}

/** The source pill in the amount card's top right: a mark (dot or 16px stock badge) and a few words. */
export function AmountSource({ mark, children }: { mark?: ReactNode; children: ReactNode }) {
  return (
    <span className="flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[13px] bg-pill pl-2 pr-2.5 text-[12px] font-semibold">
      {mark ?? <span aria-hidden className="size-[7px] rounded-[4px] bg-pos" />}
      {children}
    </span>
  );
}

/** The round mark before the amount: the USDC coin for cash (was F1-4's green "$"), lime credit hand for credit (F2-5). */
export function AmountBadge({ kind }: { kind: "cash" | "credit" }) {
  return kind === "cash" ? (
    <CashMark size={30} />
  ) : (
    <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center rounded-[15px] bg-brand text-ink">
      <CreditIcon size={16} strokeWidth={1.8} />
    </span>
  );
}

/**
 * The round ↓ between what is paid and what arrives (F1-4, F2-5), overlapping both cards. With `onFlip` it is NYM's
 * flip button (the Trade sheet): ↑↓, and a tap swaps what you pay and what you get.
 */
export function AmountArrow({ onFlip, disabled }: { onFlip?: () => void; disabled?: boolean } = {}) {
  // The boards' 34px circle sits inside its 1px border (content-box): 36px across.
  const circle = "flex size-9 items-center justify-center rounded-[18px] border border-line-field bg-ground text-ink";
  if (onFlip) {
    return (
      <div className="relative z-[1] -my-2.5 flex justify-center">
        <button
          type="button"
          onClick={onFlip}
          disabled={disabled}
          aria-label="Switch what you pay and what you get"
          // 36px to the eye; the overlay takes the tap target to 44px, as the pickers' does.
          className={`${circle} relative transition after:absolute after:-inset-[5px] after:content-[''] hover:border-line-strong active:scale-90 disabled:opacity-45`}
        >
          <TradeIcon size={15} strokeWidth={1.8} />
        </button>
      </div>
    );
  }
  return (
    <span aria-hidden className="relative z-[1] -my-2.5 flex justify-center">
      <span className={circle}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
      </span>
    </span>
  );
}

/**
 * What arrives (F1-4, F2-5): "You get (estimated)", the stock's badge, its shares to 4 places and the price. `shares`
 * null while quoting. `source`, top right: the Trade sheet's To picker.
 */
export function YouGet({ symbol, shares, priceUsd, source }: { symbol: string; shares: number | null; priceUsd: number; source?: ReactNode }) {
  return <Arrives mark={<StockAvatar symbol={symbol} />} amount={shares === null ? null : shares.toFixed(4)} unit={tickerOf(symbol)} priceUsd={priceUsd} source={source} />;
}

/** What a sale pays, in YouGet's card: the cash badge, dollars and the price a share. `usd` null while quoting. */
export function YouGetCash({ usd, priceUsd, source }: { usd: number | null; priceUsd: number; source?: ReactNode }) {
  return <Arrives mark={<AmountBadge kind="cash" />} amount={usd === null ? null : formatUsd(usd)} unit="Cash" priceUsd={priceUsd} source={source} />;
}

function Arrives({ mark, amount, unit, priceUsd, source }: { mark: ReactNode; amount: string | null; unit: string; priceUsd: number; source?: ReactNode }) {
  const label = <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">You get (estimated)</span>;
  return (
    <div className="flex flex-col gap-2 rounded-[16px] border border-line-field bg-card p-3.5 leading-[normal]">
      {source ? (
        <div className="flex items-center justify-between gap-2">
          {label}
          {source}
        </div>
      ) : (
        label
      )}
      <div className="flex items-center gap-2.5">
        {mark}
        <div className="min-w-0 flex-1">
          <div className="num text-2xl font-semibold leading-[1.1] tracking-[-0.03em]" aria-live="polite">
            {amount ?? "…"}
          </div>
          <div className="text-[12px] text-subtle">{unit}</div>
        </div>
        <div className="text-right">
          <div className="text-[12px] text-subtle">Price</div>
          <div className="num text-[14px] font-semibold">{formatUsd(priceUsd)}</div>
        </div>
      </div>
    </div>
  );
}

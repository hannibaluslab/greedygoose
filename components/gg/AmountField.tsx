"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { AmountInput } from "./AmountInput";
import { CreditIcon } from "./icons";

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
 * "$" + amount, optional MAX, a hint under it.
 */
export function AmountField({
  label, source, badge, value, onValue, decimals, onMax, hint, ...rest
}: {
  label?: string;
  /** Where the money comes from, top right: an `AmountSource` pill ("Cash", "Against NVIDIA"). */
  source?: ReactNode;
  /** The 30px round mark before the amount: an `AmountBadge`. */
  badge?: ReactNode;
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
          <span aria-hidden className="mr-0.5 text-subtle transition-[font-size] duration-150 ease-out" style={{ fontSize: Math.round(size * 0.72) }}>
            $
          </span>
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
        </div>
        {onMax && (
          <button type="button" onClick={onMax} className="h-7 shrink-0 rounded-[14px] bg-[rgba(15,14,11,0.06)] px-2.5 text-xs font-semibold text-ink-mid">
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

/** The round mark before the amount: green "$" for cash (F1-4), lime credit hand for credit (F2-5). */
export function AmountBadge({ kind }: { kind: "cash" | "credit" }) {
  return kind === "cash" ? (
    <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center rounded-[15px] bg-pos text-[15px] font-bold text-white">$</span>
  ) : (
    <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center rounded-[15px] bg-brand text-ink">
      <CreditIcon size={16} strokeWidth={1.8} />
    </span>
  );
}

"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { AmountInput } from "./AmountInput";

/**
 * Size ladder from NYM's amount field: the number steps down as it lengthens so it never runs
 * under MAX. The floor is 16px, the size below which iOS zooms the page on focus.
 */
export function amountFontSize(value: string): number {
  const len = Math.max(1, value.length);
  return len <= 6 ? 30 : len <= 8 ? 26 : len <= 10 ? 22 : len <= 12 ? 19 : 16;
}

/** The canvas amount card (F1-4, F2-5): label, "$" + amount, optional MAX, a line under it. */
export function AmountField({
  label, value, onValue, decimals, onMax, hint, ...rest
}: {
  label?: string;
  onMax?: () => void;
  hint?: ReactNode;
} & Omit<ComponentProps<typeof AmountInput>, "id" | "style" | "className">) {
  const id = useId();
  const size = amountFontSize(value);
  return (
    <div className="flex flex-col gap-2 rounded-[16px] border border-line-field bg-card p-3.5 focus-within:border-ink">
      {label && (
        <label htmlFor={id} className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
          {label}
        </label>
      )}
      <div className="flex items-center gap-2.5">
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
        <span id={`${id}-hint`} className="text-xs text-subtle">
          {hint}
        </span>
      )}
    </div>
  );
}

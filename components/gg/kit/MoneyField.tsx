"use client";

import { blurOnEnter } from "@/lib/keyboard";

/**
 * A small dollar field on a settings card (board 7f's Keep as cash): 120 × 44, a 1.5px border that turns ink while
 * typing, the amount right-aligned at 17/600. The caller parses what's typed and formats what it holds ("$500"), so the
 * field always shows its value; $0 is a value here, unlike an amount to spend (AmountField).
 */
export function MoneyField({
  id,
  value,
  onValue,
  disabled,
}: {
  id: string;
  value: string;
  onValue: (typed: string) => void;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      enterKeyHint="done"
      onKeyDown={blurOnEnter}
      placeholder="$0"
      value={value}
      disabled={disabled}
      onChange={(e) => onValue(e.target.value)}
      className="num h-11 w-[120px] shrink-0 rounded-[14px] border-[1.5px] border-[rgba(14,13,11,0.14)] bg-card px-3.5 text-right text-[17px] font-semibold text-ink outline-none placeholder:text-ink-faint focus:border-ink disabled:opacity-45"
    />
  );
}

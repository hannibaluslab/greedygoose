"use client";

import type { InputHTMLAttributes } from "react";
import { blurOnEnter } from "@/lib/keyboard";

/** The field has no outline of its own; wrap it in a card with `focus-within:` styling so focus stays visible. */

/** Keeps money input valid while typing: digits, one dot, at most `decimals` decimals. */
export function cleanAmount(v: string, decimals = 2): string {
  const s = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const [int, ...rest] = s.split(".");
  const intPart = int.replace(/^0+(?=\d)/, "");
  return rest.length ? `${intPart || "0"}.${rest.join("").slice(0, decimals)}` : intPart;
}

export function AmountInput({
  value,
  onValue,
  decimals = 2,
  className = "",
  ...rest
}: { value: string; onValue: (v: string) => void; decimals?: number } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
>) {
  return (
    <input
      inputMode="decimal"
      autoComplete="off"
      enterKeyHint="done"
      onKeyDown={blurOnEnter}
      placeholder="0"
      value={value}
      onChange={(e) => onValue(cleanAmount(e.target.value, decimals))}
      className={`num w-full min-w-0 bg-transparent outline-none focus-visible:outline-none placeholder:text-ink/20 ${className}`}
      {...rest}
    />
  );
}

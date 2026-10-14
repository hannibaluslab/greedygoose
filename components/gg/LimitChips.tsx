"use client";

import { useState } from "react";
import { AmountField } from "./AmountField";
import { parseLimitUsd } from "@/lib/agents/permissions";
import { formatUsdTrim } from "@/lib/formatting";

/**
 * A limit's chips (an agent's sheet: Protect's and Rebalance's settings, Save's limit). The section title says "a day"
 * or "a week" ("Daily limit"), so the chips are only amounts. With `custom`, a last chip, Custom, opens the kit's
 * amount field for any whole number of dollars; `onChange` gets null while what's typed isn't a limit yet.
 */
export function LimitChips({
  label, options, value, onChange, size, custom = false,
}: {
  label: string;
  options: readonly number[];
  value: number | null;
  onChange: (usd: number | null) => void;
  size: "sm" | "md";
  custom?: boolean;
}) {
  // A limit that isn't one of the chips (a grant from before, the test deploy's $5) opens on Custom with it typed in.
  const [typing, setTyping] = useState(custom && value !== null && !options.includes(value));
  const [text, setText] = useState(typing && value !== null ? String(value) : "");
  const sm = size === "sm";
  const chip = (key: string, on: boolean, text: string, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`flex items-center justify-center whitespace-nowrap text-sm ${sm ? "h-[34px] rounded-[17px] px-2" : "h-9 rounded-[18px] px-2"} ${on ? "bg-ink font-semibold text-on-ink" : "bg-pill font-medium text-ink"}`}
    >
      {text}
    </button>
  );
  const count = options.length + (custom ? 1 : 0);
  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label={label} className={`num grid ${sm ? "gap-1.5" : "gap-2"}`} style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
        {options.map((usd) =>
          chip(String(usd), !typing && usd === value, formatUsdTrim(usd), () => {
            setTyping(false);
            onChange(usd);
          }),
        )}
        {custom &&
          chip("custom", typing, "Custom", () => {
            setTyping(true);
            onChange(parseLimitUsd(text));
          })}
      </div>
      {typing && (
        <AmountField
          label="Custom limit"
          value={text}
          decimals={0}
          onValue={(v) => {
            // Whole dollars: what's typed after a dot is dropped, never joined to the dollars.
            const t = v.split(".")[0].replace(/\D/g, "");
            setText(t);
            onChange(parseLimitUsd(t));
          }}
          autoFocus
        />
      )}
    </div>
  );
}

/** The one line under a limit's title ("Daily limit"): "Protect never moves more than this in a day." */
export const neverMoreThan = (name: string, per: "day" | "week") => `${name} never moves more than this in a ${per}.`;

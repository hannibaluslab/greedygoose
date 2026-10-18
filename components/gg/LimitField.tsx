"use client";

import { useState } from "react";
import { AmountField } from "./AmountField";
import { parseLimitUsd } from "@/lib/agents/permissions";

/**
 * An agent's limit (ruling 20): one amount field, in whole dollars, that the user types; no preset chips. The card's
 * title says "a day" or "a week" ("Daily limit") and names the field for screen readers. `onChange` gets null while
 * what's typed isn't a limit yet.
 */
export function LimitField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (usd: number | null) => void;
}) {
  const [text, setText] = useState(value !== null ? String(value) : "");
  return (
    <AmountField
      aria-label={label}
      value={text}
      decimals={0}
      onValue={(v) => {
        // Whole dollars: what's typed after a dot is dropped, never joined to the dollars.
        const t = v.split(".")[0].replace(/\D/g, "");
        setText(t);
        onChange(parseLimitUsd(t));
      }}
    />
  );
}

/** The one line under a limit's title ("Daily limit"): "Protect never moves more than this in a day." */
export const neverMoreThan = (name: string, per: "day" | "week") => `${name} never moves more than this in a ${per}.`;

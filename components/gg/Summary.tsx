import type { ReactNode } from "react";

/**
 * Label / value rows that sum up an action before it's signed:
 *   table  the review card, one row per line (F2-6 Confirm)
 *   box    the small facts under an amount (F1-4 "Arrives", "Network fee")
 */
const LOOK = {
  table: {
    list: "overflow-hidden rounded-[14px] border border-[#d9d2c3] bg-card",
    row: "flex items-center justify-between gap-3 border-b border-[#ece7dc] px-4 py-[11px] last:border-b-0",
    label: "text-[13px] text-subtle",
    value: "text-right text-[14px] font-semibold",
  },
  box: {
    list: "flex flex-col gap-[5px] rounded-[12px] border border-line-field bg-card px-3 py-2.5",
    row: "flex items-center justify-between gap-3 text-[12.5px]",
    label: "text-subtle",
    value: "text-right font-semibold text-ink-2",
  },
} as const;

export type SummaryRow = { label: ReactNode; value: ReactNode };

export function Summary({ rows, look = "table" }: { rows: SummaryRow[]; look?: keyof typeof LOOK }) {
  const l = LOOK[look];
  return (
    <dl className={`num m-0 leading-[normal] ${l.list}`}>
      {rows.map((r, i) => (
        <div key={i} className={l.row}>
          <dt className={l.label}>{r.label}</dt>
          <dd className={`m-0 ${l.value}`}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Every review lists the fee the same way: JAW takes it in USDC from the user's cash (D4, D15). */
export const NETWORK_FEE_ROW: SummaryRow = { label: "Network fee", value: "Paid from your cash" };

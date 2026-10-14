import type { ReactNode } from "react";

/** Label / value rows that sum up an action before JAW's sheet signs it: the small facts under an amount (F1-4 "Arrives", "Network fee"). */
export type SummaryRow = { label: ReactNode; value: ReactNode };

export function Summary({ rows }: { rows: SummaryRow[] }) {
  return (
    <dl className="num m-0 flex flex-col gap-[5px] rounded-[12px] border border-line-field bg-card px-3 py-2.5 leading-[normal]">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-3 text-[12.5px]">
          <dt className="text-subtle">{r.label}</dt>
          <dd className="m-0 text-right font-semibold text-ink-2">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Every screen that leads to JAW's sheet lists the fee the same way: JAW takes it in USDC from the user's cash (D4, D15). */
export const NETWORK_FEE_ROW: SummaryRow = { label: "Network fee", value: "Paid from your cash" };

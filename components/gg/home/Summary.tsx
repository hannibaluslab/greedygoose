import type { ReactNode } from "react";

/**
 * Label / value rows that sum up an action before JAW's sheet signs it: the small facts under an amount (F1-4
 * "Arrives"). No network fee row: JAW's own sheet shows the fee (Adrian, 2026-10-17). Nothing is drawn without rows.
 */
export type SummaryRow = { label: ReactNode; value: ReactNode };

export function Summary({ rows }: { rows: SummaryRow[] }) {
  if (rows.length === 0) return null;
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

import { formatUsd } from "@/lib/formatting";

/**
 * Where new credit sits against the lines that matter, in dollars of new credit:
 *   0 ──── Safe line ──── the cap
 * Green up to the Safe line, amber to the cap. The cap keeps it out of Act with a margin (Act is the line, Adrian
 * 2026-10-15), so the most you can take ends in Watch and there is no red part to reach.
 */
export function LoanMeter({ amount, safe, limit }: { amount: number; safe: number; limit: number }) {
  if (limit <= 0) return null;
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / limit) * 100))}%`;
  const at = Math.min(amount, limit);
  const watch = safe < limit;
  return (
    <div
      className="flex flex-col gap-2"
      role="img"
      aria-label={`Using ${formatUsd(amount)} of credit. Safe up to ${formatUsd(Math.min(safe, limit))}${watch ? `, Watch up to ${formatUsd(limit)}` : ""}.`}
    >
      <div className="relative h-2.5 overflow-visible rounded-full">
        <div className={`absolute inset-y-0 left-0 bg-safe ${watch ? "rounded-l-full" : "rounded-full"}`} style={{ width: pct(safe) }} />
        {watch && <div className="absolute inset-y-0 right-0 rounded-r-full bg-watch" style={{ left: pct(safe) }} />}
        {/* the Safe line */}
        {watch && <span aria-hidden className="absolute -top-1 h-[18px] w-0.5 rounded bg-ink" style={{ left: pct(safe) }} />}
        {/* where this credit lands */}
        {amount > 0 && (
          <span
            aria-hidden
            className="absolute -top-[5px] size-5 -translate-x-1/2 rounded-full border-[2.5px] border-ink bg-card shadow-[0_2px_6px_rgba(14,13,11,0.18)]"
            style={{ left: pct(at) }}
          />
        )}
      </div>
      <div className="num grid grid-cols-2 gap-2 text-[11.5px] leading-[1.25]">
        <Legend color="bg-safe" label="Safe up to" value={formatUsd(Math.min(safe, limit))} tone="text-safe" />
        {watch && <Legend color="bg-watch" label="Watch up to" value={formatUsd(limit)} tone="text-watch-text" />}
      </div>
    </div>
  );
}

function Legend({ color, label, value, tone }: { color: string; label: string; value: string; tone: string }) {
  return (
    <span className="flex items-start gap-1.5">
      <span aria-hidden className={`mt-[3px] size-2 shrink-0 rounded-full ${color}`} />
      <span className="flex flex-col">
        <span className="text-subtle">{label}</span>
        <span className={`font-semibold ${tone}`}>{value}</span>
      </span>
    </span>
  );
}

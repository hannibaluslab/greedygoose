import { formatUsd } from "@/lib/formatting";

/**
 * Where a borrow sits against the lines that matter, in dollars of new borrowing:
 *   0 ──── Safe line ──── Watch line ──── Aave's limit
 * Green up to the Safe line, amber to the Watch line, red to Aave's limit (liquidation).
 */
export function LoanMeter({ amount, safe, watch, limit }: { amount: number; safe: number; watch: number; limit: number }) {
  if (limit <= 0) return null;
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / limit) * 100))}%`;
  const at = Math.min(amount, limit);
  return (
    <div className="flex flex-col gap-2" role="img" aria-label={`Borrowing ${formatUsd(amount)}. Safe up to ${formatUsd(safe)}, Watch up to ${formatUsd(watch)}, Aave's limit ${formatUsd(limit)}.`}>
      <div className="relative h-2.5 overflow-visible rounded-full">
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-safe" style={{ width: pct(safe) }} />
        <div className="absolute inset-y-0 bg-watch" style={{ left: pct(safe), width: `calc(${pct(watch)} - ${pct(safe)})` }} />
        <div className="absolute inset-y-0 right-0 rounded-r-full bg-act" style={{ left: pct(watch) }} />
        {/* line markers */}
        <span aria-hidden className="absolute -top-1 h-[18px] w-0.5 rounded bg-ink" style={{ left: pct(safe) }} />
        <span aria-hidden className="absolute -top-1 h-[18px] w-0.5 rounded bg-ink" style={{ left: pct(watch) }} />
        {/* where this borrow lands */}
        {amount > 0 && (
          <span
            aria-hidden
            className="absolute -top-[5px] size-5 -translate-x-1/2 rounded-full border-[2.5px] border-ink bg-card shadow-[0_2px_6px_rgba(14,13,11,0.18)]"
            style={{ left: pct(at) }}
          />
        )}
      </div>
      <div className="num grid grid-cols-3 gap-2 text-[11.5px] leading-tight">
        <Legend color="bg-safe" label="Safe up to" value={formatUsd(safe)} tone="text-safe" />
        <Legend color="bg-watch" label="Watch up to" value={formatUsd(watch)} tone="text-watch-text" />
        <Legend color="bg-act" label="Aave limit" value={formatUsd(limit)} tone="text-act" />
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

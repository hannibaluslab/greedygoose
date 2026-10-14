import { STATUS_LABEL, type Status } from "@/lib/risk/status";
import type { GuardianStatus } from "@/hooks/useGuardian";

const PILL: Record<Status, string> = {
  none: "bg-pill text-ink-mid",
  safe: "bg-pos-soft text-pos",
  watch: "bg-watch-soft text-watch-ink",
  act: "bg-neg-soft text-neg",
};

/** Pill sizes from the boards, smallest first. */
const SIZE = {
  sm: { h: 20, px: 8, font: 11, dot: 5, gap: 5 }, // Home Credit card (HomeUpliftRail)
  row: { h: 22, px: 8, font: 11.5, dot: 5, gap: 5 }, // a summary row (F2-6 "Status")
  header: { h: 22, px: 9, font: 12, dot: 6, gap: 5 }, // page header (PortfolioPage)
  md: { h: 24, px: 10, font: 12, dot: 6, gap: 5 }, // Credit sheet (HomeCreditSlide)
  lg: { h: 26, px: 10, font: 12, dot: 6, gap: 6 }, // Credit page (CreditOn)
} as const;

export type StatusPillSize = keyof typeof SIZE;

export function StatusPill({ status, size = "md" }: { status: Status; size?: StatusPillSize }) {
  const { h, px, font, dot, gap } = SIZE[size];
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap font-bold ${PILL[status]}`}
      style={{ height: h, padding: `0 ${px}px`, borderRadius: h / 2, fontSize: font, gap }}
    >
      <span aria-hidden className="rounded-[3px] bg-current" style={{ width: dot, height: dot }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * "Safe → Watch" on a review screen (F2-6). Geist has no "→", so the arrow is set in the system
 * font, as the board draws it, rather than the Arial-based fallback next/font puts after Geist.
 */
export function StatusChange({ from, to }: { from: Status; to: Status }) {
  return (
    <span className="whitespace-nowrap">
      <StatusPill status={from} size="row" /> <span className="font-[system-ui] font-medium text-subtle">→</span> <StatusPill status={to} size="row" />
    </span>
  );
}

/** Three-segment Safe / Watch / Act bar with marker. Labels always shown. */
export function StatusBar({ status, healthFactor }: { status: Status; healthFactor: number | null }) {
  // Position along the bar: HF ≥ 2.5 → far left, HF 1.0 → far right.
  const pos = healthFactor === null ? 0 : Math.min(1, Math.max(0, (2.5 - healthFactor) / 1.5));
  return (
    <div className="flex flex-col gap-2" role="img" aria-label={`Your credit is ${STATUS_LABEL[status]}`}>
      <div className="relative flex h-2 gap-1">
        <span className="rounded bg-safe" style={{ flex: 5 }} />
        <span className="rounded bg-watch" style={{ flex: 2 }} />
        <span className="rounded bg-act" style={{ flex: 1.4 }} />
        {status !== "none" && (
          <span
            aria-hidden
            className="absolute -top-1 size-4 rounded-full border-[2.5px] border-ink bg-card"
            style={{ left: `calc(${pos * 100}% - 8px)`, boxShadow: "0 2px 6px rgba(14,13,11,0.18)" }}
          />
        )}
      </div>
      <div className="flex text-xs font-semibold">
        <span className="text-safe" style={{ flex: 5 }}>Safe</span>
        <span className="text-watch-text" style={{ flex: 2 }}>Watch</span>
        <span className="text-act" style={{ flex: 1.4 }}>Act</span>
      </div>
    </div>
  );
}

/** Guardian's state: On, Off, Coming soon (its contract isn't deployed yet), or … while it loads. */
export function GuardianPill({ status }: { status: GuardianStatus }) {
  const on = status === "on";
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[12px] px-2.5 text-xs font-bold ${on ? "bg-safe-bg text-safe" : "bg-chip text-ink-mid"}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${on ? "bg-safe" : "bg-subtle"}`} />
      {status === "unconfigured" ? "Coming soon" : on ? "On" : status === "loading" ? "…" : "Off"}
    </span>
  );
}

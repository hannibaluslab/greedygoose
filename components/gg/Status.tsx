import { RISK } from "@/config/risk";
import { STATUS_LABEL, type Status } from "@/lib/risk/status";

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
 * "Safe → Watch" in a summary before JAW's sheet. Geist has no "→", so the arrow is set in the system
 * font, as the board draws it, rather than the Arial-based fallback next/font puts after Geist.
 */
export function StatusChange({ from, to }: { from: Status; to: Status }) {
  return (
    <span className="whitespace-nowrap">
      <StatusPill status={from} size="row" /> <span className="font-[system-ui] font-medium text-subtle">→</span>{" "}
      <StatusPill status={to} size="row" />
    </span>
  );
}

/** The bar's segments, in flex units: Safe, Watch, Act. */
const BAR = { safe: 5, watch: 2, act: 1.4 } as const;

/**
 * Where a health factor sits along the bar, 0 (left) to 1 (right). Each band's range fills its own segment, so the
 * marker is always on the colour its pill names: Safe from 2.5 down to 1.5, Watch down to 1.1, Act down to 1.0. One
 * straight line from 2.5 to 1.0 put every Watch below about 1.25 (the credit cap is 1.12) on the red.
 */
export function barPosition(healthFactor: number): number {
  const total = BAR.safe + BAR.watch + BAR.act;
  const along = (top: number, bottom: number, start: number, width: number) =>
    (start + width * Math.min(1, Math.max(0, (top - healthFactor) / (top - bottom)))) / total;
  if (healthFactor >= RISK.safeMin) return along(2.5, RISK.safeMin, 0, BAR.safe);
  if (healthFactor >= RISK.watchMin) return along(RISK.safeMin, RISK.watchMin, BAR.safe, BAR.watch);
  return along(RISK.watchMin, 1, BAR.safe + BAR.watch, BAR.act);
}

/**
 * The Safe, Watch and Act bar, with a marker where the credit is when there is one (`healthFactor` null: no credit,
 * no marker). The Repay sheet's own card draws now and after on the same segments.
 */
export function StatusBar({ healthFactor, label }: { healthFactor: number | null; label: string }) {
  const at = healthFactor === null ? null : barPosition(healthFactor);
  return (
    <div role="img" aria-label={label} className="relative flex h-1.5 gap-1">
      <span className="rounded bg-safe" style={{ flex: BAR.safe }} />
      <span className="rounded bg-watch" style={{ flex: BAR.watch }} />
      <span className="rounded bg-act" style={{ flex: BAR.act }} />
      {at !== null && (
        <span
          aria-hidden
          className="absolute -top-1 size-3.5 rounded-full border-2 border-card bg-ink shadow-[0_2px_6px_rgba(14,13,11,0.25)]"
          style={{ left: `calc(${at * 100}% - 7px)` }}
        />
      )}
    </div>
  );
}

/** An agent pill's colour: green when it's on, neutral otherwise. */
type AgentTone = "on" | "neutral";

const AGENT_TONE: Record<AgentTone, { pill: string; dot: string }> = {
  on: { pill: "bg-pos-soft text-pos", dot: "bg-pos" },
  neutral: { pill: "bg-pill text-ink-mid", dot: "bg-subtle" },
};

/**
 * An agent's state on its sheet (Agents board: 20px, 12px bold, 6px dot). The label is always shown, so colour is
 * never the only signal.
 */
export function AgentPill({ tone = "neutral", children }: { tone?: AgentTone; children: string }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[10px] px-2 text-xs font-bold ${AGENT_TONE[tone].pill}`}
    >
      <span aria-hidden className={`size-1.5 rounded-[3px] ${AGENT_TONE[tone].dot}`} />
      {children}
    </span>
  );
}

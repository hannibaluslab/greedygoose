import { AAVE_LINE_HF, CASH_AGENT, RISK } from "@/config/risk";
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

/**
 * The bar's segments, in flex units: Safe, Watch, Act down to Protector's line, and the edge under it, down to Aave's
 * line, in a darker red (Adrian, 2026-10-21: Watch and Act were too close to tell apart and Safe matters less; then
 * "the green a bit bigger"). Safe 25%, Watch 35%, Act 34%, the edge 6%, so 1.03 sits at the edge's start.
 */
export const BAR = { safe: 2.5, watch: 3.5, act: 3.4, edge: 0.6 } as const;

/**
 * Where a health factor sits along the bar, 0 (left) to 1 (right). Each range fills its own segment, so the marker is
 * always on the colour its pill names: Safe from 2.5 down to 1.5, Watch down to 1.1, Act down to Protector's line
 * (1.03), the edge down to Aave's (1.0). One straight line from 2.5 to 1.0 put every Watch below about 1.25 on the red.
 */
export function barPosition(healthFactor: number): number {
  const total = BAR.safe + BAR.watch + BAR.act + BAR.edge;
  const along = (top: number, bottom: number, start: number, width: number) =>
    (start + width * Math.min(1, Math.max(0, (top - healthFactor) / (top - bottom)))) / total;
  if (healthFactor >= RISK.safeMin) return along(2.5, RISK.safeMin, 0, BAR.safe);
  if (healthFactor >= RISK.watchMin) return along(RISK.safeMin, RISK.watchMin, BAR.safe, BAR.watch);
  if (healthFactor >= CASH_AGENT.triggerHf)
    return along(RISK.watchMin, CASH_AGENT.triggerHf, BAR.safe + BAR.watch, BAR.act);
  return along(CASH_AGENT.triggerHf, AAVE_LINE_HF, BAR.safe + BAR.watch + BAR.act, BAR.edge);
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
      <span className="rounded bg-act-edge" style={{ flex: BAR.edge }} />
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

/**
 * The bar with where the credit is now and where a change leaves it (the Repay sheet's card, Credit Buy's amount step):
 * a hollow dot now, a solid dot labelled After, and the stretch between. `after` undefined: nothing changes yet, one
 * solid dot where it is. A health factor of null (nothing owed) sits at the bar's start.
 */
export function StatusMoveBar({
  now,
  after,
  label,
  className = "",
}: {
  now: number | null;
  after?: number | null;
  label: string;
  className?: string;
}) {
  const at = now === null ? 0 : barPosition(now);
  const moves = after !== undefined;
  const to = !moves ? at : after === null ? 0 : barPosition(after);
  return (
    <div role="img" aria-label={label} className={`relative flex h-1.5 gap-1 ${className}`}>
      <span className="rounded bg-safe" style={{ flex: BAR.safe }} />
      <span className="rounded bg-watch" style={{ flex: BAR.watch }} />
      <span className="rounded bg-act" style={{ flex: BAR.act }} />
      <span className="rounded bg-act-edge" style={{ flex: BAR.edge }} />
      {moves && (
        <>
          {/* The way it moves, from now to after. */}
          <span
            aria-hidden
            className="absolute top-px h-1 rounded-sm bg-ink/55"
            style={{ left: `${Math.min(at, to) * 100}%`, width: `${Math.abs(at - to) * 100}%` }}
          />
          <span
            aria-hidden
            className="absolute -top-[22px] w-10 text-center text-[10.5px] font-bold text-ink"
            style={{ left: `calc(${to * 100}% - 20px)` }}
          >
            After
          </span>
          <span
            aria-hidden
            className="absolute -top-[3px] size-3 rounded-full border-2 border-ink/35 bg-ground"
            style={{ left: `calc(${at * 100}% - 6px)` }}
          />
        </>
      )}
      <span
        aria-hidden
        className="absolute -top-1 size-3.5 rounded-full border-2 border-card bg-ink shadow-[0_2px_6px_rgba(14,13,11,0.25)]"
        style={{ left: `calc(${to * 100}% - 7px)` }}
      />
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

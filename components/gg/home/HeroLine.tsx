import { ValueLine } from "../ValueLine";

/**
 * The line under Home's total balance: all-time P&L at each day's end, with its dashed $0 line, once it can be added up
 * (usePnl, Adrian 2026-10-19); a pulse while it is; else the total balance's week, as before.
 */
export function HeroLine({
  pnl,
  pnlReading,
  ...week
}: {
  /** The P&L points (lib/pnl pnlSeries), when there are any. */
  pnl: number[] | undefined;
  pnlReading: boolean;
} & Parameters<typeof BalanceLine>[0]) {
  if (pnl && pnl.length >= 2)
    return (
      <ValueLine
        points={pnl}
        // 40px, as the week's line.
        height={40}
        loading={false}
        onRetry={() => {}}
        label="Your profit or loss since your first money in, at the end of each day"
        caption=""
        zero
      />
    );
  if (pnlReading) return <ValueLine points={null} height={40} loading onRetry={() => {}} />;
  return <BalanceLine {...week} />;
}

/**
 * The line under the hero is the total balance's week (Adrian): what's held now, at each day's market prices, plus
 * the cash, so it ends on the big number. With no stocks it's the cash alone, a flat line; a flat line is neither
 * green nor red.
 */
function BalanceLine({
  held,
  stockWeek,
  cashUsd,
  loading,
  onRetry,
}: {
  held: boolean;
  stockWeek: number[] | null;
  cashUsd: number;
  loading: boolean;
  onRetry: () => void;
}) {
  const points = held ? (stockWeek ? stockWeek.map((v) => v + cashUsd) : null) : [cashUsd, cashUsd];
  const flat = !!points && points[0] === points[points.length - 1];
  return (
    <ValueLine
      points={points}
      // 40px: down from the board's 68 (Adrian: smaller), then 44 → 40 so Home fits above the tab bar (2026-10-22).
      height={40}
      loading={held && loading}
      onRetry={onRetry}
      label="What your total balance was worth over the last 7 days: what you hold now, at market prices"
      // No caption (Adrian): the line sits under the total balance, so it needs no title of its own.
      caption=""
      neutral={flat}
    />
  );
}

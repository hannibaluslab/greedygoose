import { Sparkline } from "./Sparkline";
import { LINE_POINTS, downsample } from "@/lib/prices/market";

/** The caption's height under the line: 4px above its 12px line. */
const CAPTION = 16;

/**
 * The line under the balance hero (HomeUpliftRail draws it 68px tall, PortfolioPage 34px): what the stocks held now
 * were worth over the last 7 days at market prices, ending on the lime dot. Market prices are labelled as such
 * (CLAUDE.md, "Oracle"). A pulse while they load; a plain line with Try again when they can't be had.
 */
export function ValueLine({
  points, height, loading, onRetry,
}: { points: number[] | null; height: number; loading: boolean; onRetry: () => void }) {
  // The pulse covers the caption too, so nothing moves when the line lands.
  if (loading) return <div aria-busy className="animate-pulse rounded-[14px] bg-chip" style={{ height: height + CAPTION }} />;
  if (!points) {
    return (
      <p role="status" className="m-0 flex items-center justify-between gap-3 px-1 text-[13px] leading-[normal] text-ink-mid">
        Market prices aren’t available right now.
        <button type="button" onClick={onRetry} className="-my-3 h-11 shrink-0 font-semibold text-ink">Try again</button>
      </p>
    );
  }
  return (
    <div>
      <Sparkline
        points={downsample(points, LINE_POINTS.hero)}
        variant="hero"
        height={height}
        label="What your stocks were worth over the last 7 days, at market prices"
      />
      <span aria-hidden className="mt-1 block font-mono text-[10px] uppercase leading-3 tracking-[0.08em] text-subtle">
        Market prices · 7 days
      </span>
    </div>
  );
}

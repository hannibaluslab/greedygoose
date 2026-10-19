import { Sparkline } from "./home/Sparkline";
import { LINE_POINTS, downsample } from "@/lib/prices/market";
import { RetryButton } from "./kit/RetryButton";

/**
 * The line under the balance hero (HomeUpliftRail draws it 68px tall, PortfolioPage 34px): what the stocks held now
 * were worth over the last 7 days at market prices, ending on the lime dot. Market prices are labelled as such
 * (CLAUDE.md, "Oracle"), inside the line's box so it keeps the boards' height. A pulse while they load; a plain line
 * with Try again when they can't be had.
 */
export function ValueLine({
  points,
  height,
  loading,
  onRetry,
  label = "What your stocks were worth over the last 7 days, at market prices",
  caption = "Market prices · 7 days",
  neutral = false,
  zero = false,
  unavailable = "Market prices aren’t available right now.",
}: {
  points: number[] | null;
  height: number;
  loading: boolean;
  onRetry: () => void;
  label?: string;
  caption?: string;
  neutral?: boolean;
  /** The P&L line: a dashed $0 line (Sparkline's `zero`). */
  zero?: boolean;
  /** What the line says when it can't be drawn. */
  unavailable?: string;
}) {
  if (loading) return <div aria-busy className="animate-pulse rounded-[14px] bg-chip" style={{ height }} />;
  if (!points) {
    return (
      <p
        role="status"
        className="m-0 flex items-center justify-between gap-3 px-1 text-[13px] leading-[normal] text-ink-mid"
      >
        {unavailable}
        <RetryButton look="inline" onClick={onRetry} />
      </p>
    );
  }
  return (
    <Sparkline
      points={downsample(points, LINE_POINTS.hero)}
      variant="hero"
      height={height}
      label={label}
      caption={caption}
      tone={neutral ? "neutral" : undefined}
      zero={zero}
    />
  );
}

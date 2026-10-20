import { useId } from "react";
import { formatUsdTrim } from "@/lib/formatting";

/** Round a range/step to a "nice" 1/2/5×10ⁿ value (axis-label algorithm). */
function niceNum(range: number): number {
  const exp = Math.floor(Math.log10(range || 1));
  const f = range / 10 ** exp;
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nf * 10 ** exp;
}

/** Room on the right for the price labels, so the line and today's dot never run under them. */
const GUTTER = 46;
const TONE = { pos: "var(--pos)", neg: "var(--neg)" } as const;

/**
 * NYM's PriceChart in the GreedyGoo kit: the line over a fading area, faint gridlines at round prices labelled on
 * the right, and the lime dot on the newest price (the hero line's). The gridlines fit the series to nice round
 * prices, so the labels read cleanly across any range. Green when the range ends up, red when it ends down.
 */
export function PriceChart({
  points,
  height = 150,
  label,
  className = "",
}: {
  points: number[];
  height?: number;
  label: string;
  className?: string;
}) {
  const gid = `chart${useId().replace(/[^\w-]/g, "")}`;
  if (points.length < 2) return null;

  const dataMin = Math.min(...points);
  const dataMax = Math.max(...points);
  const TICKS = 4;
  const step = niceNum((dataMax - dataMin || dataMax || 1) / (TICKS - 1));
  const gridMin = Math.floor(dataMin / step) * step;
  const gridMax = Math.ceil(dataMax / step) * step;
  const span = gridMax - gridMin || 1;
  const levels: number[] = [];
  for (let v = gridMin; v <= gridMax + step * 0.001; v += step) levels.push(v);
  const top = (v: number) => `${(1 - (v - gridMin) / span) * 100}%`;

  const W = 100;
  const H = 100;
  const xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const ys = points.map((p) => H - ((p - gridMin) / span) * H);
  const line = `M${xs[0]},${ys[0]} ${xs
    .slice(1)
    .map((x, i) => `L${x},${ys[i + 1]}`)
    .join(" ")}`;
  const area = `${line} L${W},${H} L0,${H} Z`;
  const stroke = TONE[points[points.length - 1] >= points[0] ? "pos" : "neg"];

  return (
    <div role="img" aria-label={label} className={`relative ${className}`} style={{ height }}>
      {/* Faint gridlines, behind the chart, full width. */}
      {levels.map((lv) => (
        <div
          key={`g${lv}`}
          aria-hidden
          className="absolute inset-x-0 border-t border-hairline"
          style={{ top: top(lv) }}
        />
      ))}

      <div aria-hidden className="absolute inset-y-0 left-0" style={{ right: GUTTER }}>
        <svg className="block h-full w-full overflow-visible" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gid})`} />
          <path
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* HTML, so it stays round while the line stretches. */}
        <span
          className="absolute size-[5.5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_0_1.5px_#0e0d0b]"
          style={{ left: "100%", top: `${ys[ys.length - 1]}%` }}
        />
      </div>

      {/* Price references in the right-hand gutter, on the card's white as NYM's sit on the sheet, so the gridline stops short of each. */}
      {levels.map((lv) => (
        <span
          key={`l${lv}`}
          aria-hidden
          className="num absolute right-0 -translate-y-1/2 bg-card pl-1 font-mono text-[10px] leading-none text-subtle"
          style={{ top: top(lv) }}
        >
          {formatUsdTrim(lv)}
        </span>
      ))}
    </div>
  );
}

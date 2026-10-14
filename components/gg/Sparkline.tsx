import { useId } from "react";

/**
 * NYM's Sparkline, drawn the three ways the boards draw it:
 *   card  Home rail holding card (HomeUpliftRail): line over a faint area
 *   row   Portfolio holding row (PortfolioPage): the same, with a dot on the last point
 *   hero  under the balance hero: a fading area and a lime dot on today
 * Tone follows the change it sits next to (green up, red down); by default, first point vs last.
 * Without `width` it fills its container; the dot is HTML so it stays round when the line stretches.
 * A span, so it can sit inside a tappable card (a button holds phrasing content only).
 */
const LOOK = {
  card: { stroke: 1.6, area: 0.08, pad: { l: 1.4, r: 3.4, t: 3, b: 3 } },
  row: { stroke: 1.6, area: 0.09, pad: { l: 2, r: 2, t: 2, b: 2 } },
  hero: { stroke: 1.8, area: 0.18, pad: { l: 2, r: 10, t: 7, b: 7 } },
} as const;

const TONE = { pos: "#1f6a4a", neg: "#8e2a1d" } as const;

export function Sparkline({
  points, height, width, variant = "card", tone, label, className = "",
}: {
  points: number[];
  height: number;
  width?: number;
  variant?: keyof typeof LOOK;
  tone?: keyof typeof TONE;
  /** Set for a chart that says something on its own (the hero); small lines sit next to their figure. */
  label?: string;
  className?: string;
}) {
  const gradientId = `spark${useId().replace(/[^\w-]/g, "")}`;
  if (points.length < 2) return null;

  const { stroke, area, pad } = LOOK[variant];
  const color = TONE[tone ?? (points[points.length - 1] >= points[0] ? "pos" : "neg")];
  const w = width ?? 350; // drawing width; the svg stretches to the container when `width` is unset
  const min = Math.min(...points);
  const range = Math.max(...points) - min;
  const xy = points.map((p, i) => ({
    x: pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r),
    y: range === 0 ? height / 2 : pad.t + (1 - (p - min) / range) * (height - pad.t - pad.b),
  }));
  const line = xy.map(({ x, y }, i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const last = xy[xy.length - 1];

  return (
    <span className={`relative block ${className}`} style={{ width: width ?? "100%", height }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        className="block"
        {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      >
        {variant === "hero" && (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={area} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}
        <path
          d={`${line} L${last.x.toFixed(2)} ${height} L${xy[0].x.toFixed(2)} ${height} Z`}
          fill={variant === "hero" ? `url(#${gradientId})` : color}
          fillOpacity={variant === "hero" ? undefined : area}
        />
        <path d={line} fill="none" stroke={color} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {variant !== "card" && (
        <span
          aria-hidden
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${(last.x / w) * 100}%`,
            top: last.y,
            ...(variant === "hero"
              ? { width: 5.5, height: 5.5, background: "#d4ff3c", boxShadow: "0 0 0 1.5px #0e0d0b" }
              : { width: 4.4, height: 4.4, background: color }),
          }}
        />
      )}
    </span>
  );
}

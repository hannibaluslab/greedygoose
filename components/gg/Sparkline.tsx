import { useId } from "react";

/**
 * NYM's Sparkline, drawn the three ways the boards draw it:
 *   card  Home rail holding card (HomeUpliftRail): line over a faint area
 *   row   Portfolio holding row (PortfolioPage): the same, with a dot on the last point
 *   hero  under the balance hero: a fading area and a lime dot on today
 * Tone follows the change it sits next to (green up, red down); by default, first point vs last.
 * Without `width` it fills its container; the dot is HTML so it stays round when the line stretches.
 * A span, so it can sit inside a tappable card (a button holds phrasing content only). A `caption` sits inside the
 * line's box, in a corner the line leaves free (captionCorner), so it takes no height of its own. `dotR` is half the
 * dot on the last point, its ring included.
 */
const LOOK = {
  card: { stroke: 1.6, area: 0.08, pad: { l: 1.4, r: 3.4, t: 3, b: 3 }, dotR: 0 },
  row: { stroke: 1.6, area: 0.09, pad: { l: 2, r: 2, t: 2, b: 2 }, dotR: 2.2 },
  hero: { stroke: 1.8, area: 0.18, pad: { l: 2, r: 10, t: 7, b: 7 }, dotR: 4.25 },
} as const;

/** `neutral`: a line that isn't the user's money (the market's week before the first stock), so it never reads as a loss. */
const TONE = { pos: "#1f6a4a", neg: "#8e2a1d", neutral: "#5a564e" } as const;

/**
 * The caption's line: Geist Mono 10px in capitals, 0.08em apart, so each character takes 6.8px; 12px tall. The
 * drawing's units are pixels at the boards' 350px width, and a wider screen only leaves the caption more room.
 */
const CAPTION = { char: 6.8, h: 12 };
/** Room kept between the caption and the line: half the hero's stroke and a pixel. */
const CLEAR = 2;

type Corner = "top-left" | "bottom-left" | "top-right" | "bottom-right";
const CORNERS: Corner[] = ["top-left", "bottom-left", "top-right", "bottom-right"];
const CORNER_CLASS: Record<Corner, string> = {
  "top-left": "left-0 top-0",
  "bottom-left": "bottom-0 left-0",
  "top-right": "right-0 top-0",
  "bottom-right": "bottom-0 right-0",
};

/**
 * Where a `width` × `height` caption sits in a `w` × `h` line's box: the first of top-left, bottom-left, top-right and
 * bottom-right that the line (and its dot, `dotR` around the last point) stays clear of, else the one it comes least
 * close to. The line is straight between points, so its highest and lowest under the caption are at points inside it
 * or where it crosses the caption's edges.
 */
export function captionCorner(
  xy: readonly { x: number; y: number }[],
  w: number,
  h: number,
  size: { width: number; height: number },
  dotR: number,
): Corner {
  const yAt = (x: number) => {
    const i = xy.findIndex((p) => p.x >= x);
    if (i <= 0) return i === 0 ? xy[0].y : xy[xy.length - 1].y;
    const a = xy[i - 1];
    const b = xy[i];
    return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  };
  const room = (corner: Corner) => {
    const left = corner.endsWith("left");
    const [from, to] = left ? [0, size.width] : [w - size.width, w];
    const ys = [yAt(from), yAt(to), ...xy.filter((p) => p.x > from && p.x < to).map((p) => p.y)];
    const last = xy[xy.length - 1];
    if (dotR > 0 && last.x + dotR > from && last.x - dotR < to) ys.push(last.y - dotR, last.y + dotR);
    return corner.startsWith("top") ? Math.min(...ys) - size.height : h - size.height - Math.max(...ys);
  };
  const rooms = CORNERS.map(room);
  const clear = rooms.findIndex((r) => r >= CLEAR);
  return CORNERS[clear >= 0 ? clear : rooms.indexOf(Math.max(...rooms))];
}

export function Sparkline({
  points, height, width, variant = "card", tone, label, caption, className = "",
}: {
  points: number[];
  height: number;
  width?: number;
  variant?: keyof typeof LOOK;
  tone?: keyof typeof TONE;
  /** Set for a chart that says something on its own (the hero); small lines sit next to their figure. */
  label?: string;
  /** What the line is, inside its box ("Market prices · 7 days"); shown only, `label` says it to a screen reader. */
  caption?: string;
  className?: string;
}) {
  const gradientId = `spark${useId().replace(/[^\w-]/g, "")}`;
  if (points.length < 2) return null;

  const { stroke, area, pad, dotR } = LOOK[variant];
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
  const corner = caption && captionCorner(xy, w, height, { width: caption.length * CAPTION.char, height: CAPTION.h }, dotR);

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
      {corner && (
        <span aria-hidden className={`absolute whitespace-nowrap font-mono text-[10px] uppercase leading-3 tracking-[0.08em] text-subtle ${CORNER_CLASS[corner]}`}>
          {caption}
        </span>
      )}
    </span>
  );
}

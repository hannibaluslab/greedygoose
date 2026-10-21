import { useId } from "react";

/** The mark's body, head and legs in one path (GooseMark's), cut into parts below so the legs can walk. */
const BODY =
  "M139.22 49.67 L135.81 28.2 C132.39 20.39 126.54 16 118.73 16 C107.02 16 98.23 24.78 98.23 36.5 C98.23 47.72 93.35 62.36 84.57 76.03 C79.69 83.83 75.78 91.64 70.9 99.45 C47.48 105.31 29.91 124.83 29.91 148.25 C29.91 163.87 31.37 174.61 35.76 181.44 C39.18 186.81 46.01 187.29 47.48 181.93 C50.41 170.7 59.19 164.85 71.88 164.85 C88.47 164.85 107.5 180.46 105.06 200.96 L101.16 228.29 L92.86 228.29 C91.4 228.29 90.42 229.26 90.42 230.73 L90.42 240 L115.31 240 L119.7 196.08 C125.56 192.66 133.37 192.66 139.22 196.08 L143.62 228.29 L134.83 228.29 C133.37 228.29 132.39 229.26 132.39 230.73 L132.39 240 L157.77 240 L153.38 194.13 C170.46 193.15 188.03 187.29 199.74 175.58 C210.47 164.85 219.26 146.3 226.09 111.16 C218.28 120.92 209.5 126.78 197.79 127.76 C172.41 128.73 139.22 116.04 127.51 103.36 C119.7 94.57 118.73 81.88 123.61 72.12 C128.49 62.36 137.27 58.46 139.22 49.67 Z";
const EGG =
  "M45.53 208.77 C45.53 188.28 57.32 171.68 71.88 171.68 C86.43 171.68 98.23 188.28 98.23 208.77 C98.23 224.4 86.43 237.07 71.88 237.07 C57.32 237.07 45.53 224.4 45.53 208.77 Z";
const BEAK = "M134.83 27.22 L169.48 16.98 C174.85 15.51 178.27 21.37 174.85 24.3 L138.25 50.65 Z";
const EYE = "M104.09 35.03 C108.48 26.74 117.75 22.83 128 24.78 C124.58 34.06 114.82 39.42 104.09 35.03 Z";
/** The same eye, shut: its lower lid as one stroke. */
const EYE_SHUT = "M104.5 33.5 C111 37.5 120 36.5 127 27";

// Theme colours (lib/theme.ts), set through `style` where every browser reads var(): ink on the light sheet, cream on
// the dark one, the eye in the sheet's own colour.
const INK = "var(--ink)";
const LIME = "#d4ff3c";
const CREAM = "var(--bg-sheet)";
/** A hairline on the lime parts, so the egg and beak hold their shape on the light sheet. */
const EDGE = "rgba(14,13,11,0.22)";

/**
 * The GreedyGoo goose, alive, for a wait (Adrian, 2026-10-21: "walk around and jump… or sleeping, something cool and
 * fun"). The mark, in ink on the light sheet (cream on the dark one), with his lime egg:
 * - `walk`: he waddles across, legs stepping, then jumps and turns in the air, and walks back. Never lets go of the egg.
 * - `sleep`: as in the film's night: eye shut, slow breathing over his egg, z's drifting up.
 * Pure CSS (globals.css, `ggl-`); with reduced motion he just stands. Decorative: the line beside it says what's waiting.
 */
export function GooseLoader({ mode = "walk", className = "" }: { mode?: "walk" | "sleep"; className?: string }) {
  const id = `ggl${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const walk = mode === "walk";
  const goose = (
    <svg viewBox="16 0 224 250" overflow="visible" className="block h-full w-auto" aria-hidden>
      <defs>
        <path id={`${id}-b`} d={BODY} />
        {/* Above the hips; each leg below its hip. The cuts overlap in ink, so a turning leg leaves no gap. */}
        <clipPath id={`${id}-top`}>
          <rect x="0" y="0" width="256" height="200" />
        </clipPath>
        <clipPath id={`${id}-l`}>
          <rect x="84" y="193" width="42" height="60" />
        </clipPath>
        <clipPath id={`${id}-r`}>
          <rect x="128" y="189" width="38" height="64" />
        </clipPath>
      </defs>
      <g className={walk ? "ggl-waddle" : "ggl-breathe"}>
        <g className={walk ? "ggl-leg-l" : undefined}>
          <use href={`#${id}-b`} style={{ fill: INK }} clipPath={`url(#${id}-l)`} />
        </g>
        <g className={walk ? "ggl-leg-r" : undefined}>
          <use href={`#${id}-b`} style={{ fill: INK }} clipPath={`url(#${id}-r)`} />
        </g>
        <use href={`#${id}-b`} style={{ fill: INK }} clipPath={`url(#${id}-top)`} />
        <path d={BEAK} fill={LIME} stroke={EDGE} strokeWidth="2" strokeLinejoin="round" />
        {walk ? (
          <path d={EYE} style={{ fill: CREAM }} />
        ) : (
          <path d={EYE_SHUT} fill="none" style={{ stroke: CREAM }} strokeWidth="4.5" strokeLinecap="round" />
        )}
        <path className="ggl-egg" d={EGG} fill={LIME} stroke={EDGE} strokeWidth="2" />
      </g>
      {!walk && (
        <g style={{ fill: INK }} fontFamily="inherit" fontWeight="700">
          <text className="ggl-z" x="150" y="8" fontSize="64">
            z
          </text>
          <text className="ggl-z ggl-z2" x="150" y="8" fontSize="52">
            z
          </text>
          <text className="ggl-z ggl-z3" x="150" y="8" fontSize="42">
            z
          </text>
        </g>
      )}
    </svg>
  );
  return (
    <span aria-hidden className={`relative block ${walk ? "ggl-stage" : ""} ${className}`}>
      {walk ? (
        <span className="ggl-track absolute bottom-0 left-1/2 block h-full">
          <span className="ggl-hop block h-full">{goose}</span>
        </span>
      ) : (
        <span className="flex h-full justify-center">{goose}</span>
      )}
    </span>
  );
}

/**
 * Renames the theme names in Leo's code that NYM's design tokens redefine, so the two
 * themes can live in one app/globals.css without changing how Leo's screens look.
 *
 *   text-muted   → text-ink-mid      (#5a564e; NYM's `muted` is a beige surface)
 *   bg-accent    → bg-brand          (#d4ff3c; NYM's `accent` is the grey pill)
 *   rounded-md   → rounded-[6px]     (NYM's radius scale: xs 6, sm 10, md 14, lg 20, xl 28)
 *   leading-tight → leading-[1.25]   (NYM's leading-tight is 0.95)
 *
 * Every utility prefix and variant is covered (hover:, border-t-, /50 opacity, …).
 * Re-runnable: run it again after merging any branch cut before the NYM port.
 * NYM-ported files are skipped, because there these names mean NYM's values.
 *
 *   node scripts/rename-colors.mjs           rewrite in place, print what changed
 *   node scripts/rename-colors.mjs --check   change nothing, exit 1 if anything would change
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["app", "components", "hooks", "lib"];
const NYM_PORTS = ["components/ui/drawer.tsx", "components/sheets/", "hooks/useSheetViewport.ts", "lib/utils.ts", "lib/keyboard.ts"];

const COLORS = { muted: "ink-mid", accent: "brand" };
const RADII = { xs: "2px", sm: "4px", md: "6px", lg: "8px", xl: "12px" }; // Tailwind 4 defaults
const COLOR_UTILS = "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|outline|decoration|divide|from|via|to|shadow|caret|accent";
const START = String.raw`(?<=^|[\s"'\`{(:!])`;
const END = String.raw`(?=$|[\s"'\`/)}\]])`;

const RULES = [
  {
    re: new RegExp(`${START}(${COLOR_UTILS})-(muted|accent)${END}`, "g"),
    to: (_, util, name) => `${util}-${COLORS[name]}`,
  },
  {
    re: new RegExp(`${START}rounded(-(?:tl|tr|br|bl|ss|se|es|ee|t|r|b|l|s|e))?-(xs|sm|md|lg|xl)${END}`, "g"),
    to: (_, side = "", size) => `rounded${side}-[${RADII[size]}]`,
  },
  { re: new RegExp(`${START}leading-tight${END}`, "g"), to: () => "leading-[1.25]" },
];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

const check = process.argv.includes("--check");
let total = 0;
for (const dir of DIRS) {
  for (const path of sourceFiles(join(ROOT, dir))) {
    const rel = relative(ROOT, path).split(sep).join("/");
    if (NYM_PORTS.some((p) => rel.startsWith(p))) continue;
    const before = readFileSync(path, "utf8");
    let count = 0;
    const after = RULES.reduce(
      (src, { re, to }) =>
        src.replace(re, (...m) => {
          count++;
          return to(...m);
        }),
      before,
    );
    if (!count) continue;
    total += count;
    console.log(`${String(count).padStart(3)}  ${rel}`);
    if (!check) writeFileSync(path, after);
  }
}
console.log(`${total} ${check ? "to rename" : "renamed"}`);
if (check && total) process.exit(1);

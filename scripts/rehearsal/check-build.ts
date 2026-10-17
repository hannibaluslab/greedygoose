/**
 * Proves a production build carries no fork signer (scripts/rehearsal/README.md, "The fence"). It builds with every
 * rehearsal variable set, the worst case, then searches everything `next build` wrote (not `.next/dev`, the dev
 * server's, nor the cache) for:
 *
 *   - the signer's marker (`REHEARSAL_SIGNER_MARKER`, which the signer uses at runtime, so it can't be tree-shaken
 *     away while the signer stays);
 *   - the badge's words;
 *   - any source map listing a file in lib/rehearsal/.
 *
 *   npm run rehearsal:check-build      # exits 1 if any is found
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");

const BADGE = "local fork · fake money";
const OUT = join(ROOT, ".next");
const SKIP = new Set([join(OUT, "dev"), join(OUT, "cache")]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP.has(path)) return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function main() {
  // The search means something only if the signer carries its marker, uses it at runtime, and the badge its words.
  const signer = readFileSync(join(ROOT, "lib/rehearsal/signer.ts"), "utf8");
  const marker = /export const REHEARSAL_SIGNER_MARKER = "([^"]+)";/.exec(signer)?.[1];
  if (!marker || !signer.includes("signer: REHEARSAL_SIGNER_MARKER")) {
    throw new Error("The signer no longer uses its marker at runtime: the check would prove nothing");
  }
  if (!readFileSync(join(ROOT, "lib/rehearsal/Badge.tsx"), "utf8").includes(BADGE)) throw new Error("The badge's words changed");

  const build = spawnSync("npx", ["next", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_PUBLIC_REHEARSAL_RPC: "http://127.0.0.1:18545",
      NEXT_PUBLIC_REHEARSAL_ACCOUNT: "0x0000000000000000000000000000000000000001",
      NEXT_PUBLIC_REHEARSAL_SIGNER: "0x0000000000000000000000000000000000000002",
      NEXT_PUBLIC_REHEARSAL_FROM_BLOCK: "1",
    },
  });
  if (build.status !== 0) throw new Error("next build failed");

  const found: string[] = [];
  const all = files(OUT);
  for (const path of all) {
    const text = readFileSync(path, "utf8");
    if (text.includes(marker)) found.push(`${relative(ROOT, path)}: the signer's marker`);
    if (text.includes(BADGE)) found.push(`${relative(ROOT, path)}: the badge`);
    if (path.endsWith(".map")) {
      const sources = (JSON.parse(text) as { sources?: string[] }).sources ?? [];
      for (const s of sources.filter((s) => s.includes("lib/rehearsal/"))) found.push(`${relative(ROOT, path)}: compiled from ${s}`);
    }
  }
  if (found.length) {
    console.error(`\nThe production build carries the fork signer:\n  ${found.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`\nOK: ${all.length} files of the production build searched, built with NEXT_PUBLIC_REHEARSAL_RPC set; no fork signer, no badge, nothing compiled from lib/rehearsal/.`);
}

main();

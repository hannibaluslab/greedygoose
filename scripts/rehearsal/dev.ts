/**
 * The real app against the fork (scripts/rehearsal/README.md, "The app"): `next dev` with .env.rehearsal.local on top
 * of .env.local, so wagmi reads the fork and the fork signer signs in place of JAW. `next dev` only: the signer
 * doesn't exist in a production build.
 *
 *   npm run rehearsal:dev                 # http://localhost:3100, signs in as sam
 *   npm run rehearsal:dev -- --as ana
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ENV_FILE, NAMES, ROOT, readState, type Name } from "./lib";

const asIndex = process.argv.indexOf("--as");
const as = (asIndex >= 0 ? process.argv[asIndex + 1] : "sam") as Name;
if (!NAMES.includes(as)) {
  console.error(`--as takes ${NAMES.join(" or ")}`);
  process.exit(2);
}
if (!existsSync(ENV_FILE)) {
  console.error("No .env.rehearsal.local: run npm run rehearsal:setup");
  process.exit(1);
}
const state = readState();
const env: NodeJS.ProcessEnv = { ...process.env };
for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
env.NEXT_PUBLIC_REHEARSAL_ACCOUNT = state.accounts[as].address;
env.NEXT_PUBLIC_REHEARSAL_SIGNER = state.accounts[as].signer;
const port = process.env.REHEARSAL_APP_PORT ?? "3100";
console.log(
  `Rehearsal: the app on http://localhost:${port}, signing in as ${as} (${state.accounts[as].address}) on ${state.rpc}`,
);
const child = spawn("npx", ["next", "dev", "--port", port], { cwd: ROOT, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

/**
 * Moves the fork's clock forward (scripts/rehearsal/README.md, "Time warp"): evm_increaseTime, then a block. For the
 * Rebalancer's next session (20 hours after the last one opened), a rescue's 7-day end, or prices reopening after a
 * weekend.
 *
 *   npm run rehearsal:warp -- 30m      # also 90s, 2h, 1d
 *
 * The fork keeps its new time; the browser's clock doesn't move, so the app's own countdowns read from now.
 */
import { marketState } from "@/lib/market-hours";
import { connectFork, nyTime, readState } from "./lib";

const UNIT = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

async function main() {
  const m = /^(\d+)([smhd])$/.exec(process.argv[2] ?? "");
  if (!m) {
    console.error("usage: npm run rehearsal:warp -- <90s | 30m | 2h | 1d>");
    process.exit(2);
  }
  const seconds = Number(m[1]) * UNIT[m[2] as keyof typeof UNIT];
  const state = readState();
  const fork = await connectFork(state.rpc);
  const before = (await fork.pub.getBlock()).timestamp;
  await fork.test.increaseTime({ seconds });
  await fork.test.mine({ blocks: 1 });
  const after = (await fork.pub.getBlock()).timestamp;
  // GooseGuard has no calendar (decision 7): the agents act whenever Aave and the 1% price check allow.
  const open = marketState(new Date(Number(after) * 1000)).open;
  console.log(`Fork time: ${nyTime(before)} → ${nyTime(after)} (+${Number(after - before).toLocaleString("en-US")} s)`);
  console.log(`Aave's stock prices are ${open ? "live" : "held (markets closed)"}`);
}

main().catch((e) => {
  console.error(`\ntime-warp failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

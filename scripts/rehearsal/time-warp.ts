/**
 * Moves the fork's clock forward (scripts/rehearsal/README.md, "Time warp"): evm_increaseTime, then a block. For
 * Protect's heads-up (it sells 30 minutes later), a daily limit's next period, or the Rebalancer's window.
 *
 *   npm run rehearsal:warp -- 30m      # also 90s, 2h, 1d
 *
 * The fork keeps its new time; the browser's clock doesn't move, so the app's own countdowns read from now.
 */
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
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
  const frozen = await fork.pub.readContract({ address: state.executor, abi: gooseExecutorAbi, functionName: "frozen", args: [after] });
  console.log(`Fork time: ${nyTime(before)} → ${nyTime(after)} (+${Number(after - before).toLocaleString("en-US")} s)`);
  console.log(`Stock prices are ${frozen ? "held (markets closed): Protect won't sell" : "live"}`);
}

main().catch((e) => {
  console.error(`\ntime-warp failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

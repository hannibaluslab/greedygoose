/**
 * Moves a stock's price on the fork where the spoke reads it (scripts/rehearsal/README.md, "Price shock"), to push an
 * account into Watch or Act. The spoke's oracle prices reserve r with `latestAnswer()` on its source
 * (`getReserveSource(r)`, a Chainlink proxy); this puts RehearsalFeed's code at that source and writes the new price.
 * Aave, the app and GooseExecutor all read the same oracle, so all of them see it. The stock's pools don't move: a buy
 * of a shocked stock is blocked by the app's 10% guard, and Protect sells into a pool above Aave's price.
 *
 *   npm run rehearsal:shock -- NVDAc -25%     # down 25% from Aave's price now
 *   npm run rehearsal:shock -- NVDAc 150      # $150 a share
 *   npm run rehearsal:shock -- NVDAc reset    # the real feed back
 */
import { keccak256, pad, stringToHex, toHex, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { EQUITIES } from "@/lib/tokens/registry";
import { ROOT, connectFork, health, readState, usd, writeState, type Fork, type State } from "./lib";

/** RehearsalFeed's storage (contracts/script/rehearsal/RehearsalFeed.sol). */
const ANSWER_SLOT = keccak256(stringToHex("greedygoose.rehearsal.feed.answer"));

async function main() {
  const [symbol, change] = process.argv.slice(2);
  const stock = EQUITIES.find((e) => e.symbol.toLowerCase() === symbol?.toLowerCase());
  if (!stock || !change) {
    console.error(`usage: npm run rehearsal:shock -- <${EQUITIES.map((e) => e.symbol).join("|")}> <-25% | +10% | 150 | reset>`);
    process.exit(2);
  }
  const state = readState();
  const fork = await connectFork(state.rpc);
  const r = BigInt(stock.reserveId);
  const price = () => fork.pub.readContract({ address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [r] });
  const source = (await fork.pub.readContract({ address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReserveSource", args: [r] })) as Address;
  const before = await price();
  const healthBefore = await healths(fork, state);

  if (change === "reset") {
    const saved = state.feeds[stock.symbol];
    if (!saved) throw new Error(`${stock.symbol}'s price was never shocked`);
    await fork.test.setCode({ address: saved.source, bytecode: saved.code });
    delete state.feeds[stock.symbol];
  } else {
    const next = target(before, change);
    if (!state.feeds[stock.symbol]) {
      const code = (await fork.pub.getCode({ address: source })) ?? "0x";
      state.feeds[stock.symbol] = { source, code };
      const feed = (JSON.parse(readFileSync(join(ROOT, "contracts/out/RehearsalFeed.sol/RehearsalFeed.json"), "utf8")) as { deployedBytecode: { object: Hex } })
        .deployedBytecode.object;
      await fork.test.setCode({ address: source, bytecode: feed });
    }
    await fork.test.setStorageAt({ address: source, index: ANSWER_SLOT, value: pad(toHex(next), { size: 32 }) });
  }
  writeState(state);
  await fork.test.mine({ blocks: 1 });

  const after = await price();
  console.log(`${stock.name} (${stock.symbol}) on Aave's oracle: ${usd(before, 8)} → ${usd(after, 8)}`);
  const healthAfter = await healths(fork, state);
  for (const [name, h] of Object.entries(healthAfter)) {
    if (h !== null) console.log(`  ${name}: health ${health(healthBefore[name]!)} → ${health(h)}`);
  }
}

/** The new price, 8 decimals, from "-25%", "+10%" or "150" (dollars a share). */
function target(now: bigint, change: string): bigint {
  const pct = /^([+-]\d+(?:\.\d+)?)%$/.exec(change);
  if (pct) {
    const bps = BigInt(Math.round(Number(pct[1]) * 100));
    if (bps <= -10_000n) throw new Error("A price can't fall 100% or more");
    return (now * (10_000n + bps)) / 10_000n;
  }
  const abs = /^(\d+(?:\.\d+)?)$/.exec(change);
  if (abs) return BigInt(Math.round(Number(abs[1]) * 1e8));
  throw new Error(`"${change}" isn't -25%, +10%, 150 or reset`);
}

async function healths(fork: Fork, state: State): Promise<Record<string, bigint | null>> {
  const out: Record<string, bigint | null> = {};
  for (const [name, a] of Object.entries(state.accounts)) {
    const d = await fork.pub.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [a.address] });
    out[name] = d.totalDebtValueRay > 0n ? d.healthFactor : null;
  }
  return out;
}

main().catch((e) => {
  console.error(`\nprice-shock failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

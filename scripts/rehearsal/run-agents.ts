/**
 * Runs the agents on the fork the way KeeperHub runs them on Base (scripts/rehearsal/README.md, "Agents"; the runner
 * itself lives outside this repo), with the runner setup.ts made (an anvil dev account) in KeeperHub's place:
 *
 *   A round (checkData = abi.encode(0, 1), as KeeperHub sends it): GoosePlanner's `checkUpkeep`, then GooseGuard's
 *   `performUpkeep` with the moves it planned, at 5.4M gas. `--until-idle` repeats until nothing is planned (a rescue
 *   goes on in the next rounds until the credit is back at the target), at most 5 times.
 *
 * There is no registration step: the account registers its own grants in the app's batch (`register(job, permission)`).
 * What each round did is printed from the Guard's events, refusals included. It needs GoosePlanner on the fork
 * (`planner` in .rehearsal/state.json): it isn't built yet.
 *
 *   npm run rehearsal:agents
 *   npm run rehearsal:agents -- --until-idle
 */
import { encodeAbiParameters, encodeFunctionData, type Address } from "viem";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { plannerAbi } from "@/lib/agents/abis/GoosePlanner";
import { connectFork, describeGuardLogs, health, namer, readState, type Fork, type State } from "./lib";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";

const ACTIONS = ["None", "Prune", "Repay", "Save", "Sell", "EndRescue", "Defer", "Rebalance", "Convert"] as const;
const JOBS = ["Save", "Protect", "Protect · sell", "Rebalance", "Receive"] as const;

async function main() {
  const untilIdle = process.argv.includes("--until-idle");
  const state = readState();
  const fork = await connectFork(state.rpc);
  const who = namer(state);
  if (!(await fork.pub.getCode({ address: state.guard })))
    throw new Error("No GooseGuard on this fork: it restarted? Run npm run rehearsal:setup");
  const planner = state.planner;
  if (!planner || !(await fork.pub.getCode({ address: planner })))
    throw new Error("No GoosePlanner on this fork yet: deploy it and set `planner` in .rehearsal/state.json");

  for (let i = 0; i < (untilIdle ? 5 : 1); i++) {
    const did = await roundOnce(fork, state, planner, who, i + 1);
    if (!did) break;
  }

  for (const name of Object.keys(state.accounts) as (keyof State["accounts"])[]) {
    const a = state.accounts[name].address;
    const [account] = await fork.pub.readContract({
      address: state.guard,
      abi: guardAbi,
      functionName: "accountOf",
      args: [a],
    });
    const on = JOBS.filter((_, j) => (account.jobs & (1 << j)) !== 0);
    const d = await fork.pub.readContract({
      address: AAVE.SPOKE,
      abi: spokeAbi,
      functionName: "getUserAccountData",
      args: [a],
    });
    console.log(
      `${name}: ${on.length ? on.join(", ") + " on" : "no agents on"}${d.totalDebtValueRay > 0n ? `, health ${health(d.healthFactor)}` : ""}`,
    );
  }
}

/** One round: the Planner's read, then the Guard's write. Returns whether it did anything. */
async function roundOnce(
  fork: Fork,
  state: State,
  planner: Address,
  who: (a: Address) => string,
  n: number,
): Promise<boolean> {
  const checkData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [0n, 1n]);
  const [needed, performData] = await fork.pub.readContract({
    address: planner,
    abi: plannerAbi,
    functionName: "checkUpkeep",
    args: [checkData],
    account: state.runner,
  });
  console.log(`\nRound ${n}: checkUpkeep(shard 0 of 1)`);
  if (!needed) {
    console.log("  nothing to do");
    for (const name of Object.keys(state.accounts) as (keyof State["accounts"])[]) {
      const p = await fork.pub.readContract({
        address: planner,
        abi: plannerAbi,
        functionName: "planOf",
        args: [state.accounts[name].address],
      });
      if (p.action !== 0)
        console.log(`  ${name}: planOf says ${ACTIONS[p.action]} (${JOBS[p.job]}), not planned this round`);
    }
    return false;
  }
  const receipt = await fork.send(
    state.runner,
    state.guard,
    encodeFunctionData({ abi: guardAbi, functionName: "performUpkeep", args: [performData] }),
    "performUpkeep",
    ROUND_GAS,
  );
  const lines = describeGuardLogs(receipt.logs, state.guard, who);
  for (const line of lines.length ? lines : ["the round moved nothing"]) console.log(`  ${line}`);
  console.log(`  performUpkeep ${receipt.transactionHash} (${receipt.gasUsed.toLocaleString("en-US")} gas)`);
  return true;
}

/**
 * The gas a round's write is sent with: KeeperHub's write step (spec-final-v2.md §10, packing at 5.3M plus the loop).
 * Never an estimate: the Guard refuses a move it has no gas for (`Refused(NoGas)`), so an estimate finds exactly that.
 */
const ROUND_GAS = 5_400_000n;

main().catch((e) => {
  console.error(`\nrun-agents failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

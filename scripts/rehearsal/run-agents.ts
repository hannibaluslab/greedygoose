/**
 * Runs the agents on the fork the way the runner runs them on Base (scripts/rehearsal/README.md, "Agents"; the runner
 * itself lives outside this repo, and Chainlink Automation is gone since 2026-10-19), with the forwarder setup.ts
 * bootstrapped (an anvil dev account) in the runner's place:
 *
 *   1. Registration: every PermissionApproved the manager emitted since the last run is read with GooseExecutor's
 *      `registrationOf`, and each one it accepts is registered with `registerApproved`, at 1M gas.
 *   2. A run (the safety-net round, checkData = abi.encode(0, 1)): `checkUpkeep`, then `performUpkeep` with the
 *      accounts it lists, at 5M gas. `--until-idle` repeats until nothing is listed (a rescue goes on in the next
 *      runs until the credit is back at 1.12), at most 5 times.
 *
 * What each step did is printed from the executor's events.
 *
 *   npm run rehearsal:agents
 *   npm run rehearsal:agents -- --until-idle
 */
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAbiItem, type Address } from "viem";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { permissionManagerAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { connectFork, describeExecutorLogs, health, namer, readState, writeState, type Fork, type State } from "./lib";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";

const MANAGER = PROTOCOLS.PERMISSION_MANAGER as Address;
const APPROVED = getAbiItem({ abi: permissionManagerAbi, name: "PermissionApproved" });
const ACTIONS = ["None", "Prune", "Repay", "Save", "Sell", "EndRescue", "Defer", "Rebalance", "Convert"] as const;
const JOBS = ["Save", "Protect", "Protect · sell", "Rebalance", "Receive"] as const;

async function main() {
  const untilIdle = process.argv.includes("--until-idle");
  const state = readState();
  const fork = await connectFork(state.rpc);
  const who = namer(state);
  if (!(await fork.pub.getCode({ address: state.executor })))
    throw new Error("No executor on this fork: it restarted? Run npm run rehearsal:setup");

  await register(fork, state, who);

  for (let i = 0; i < (untilIdle ? 5 : 1); i++) {
    const did = await runOnce(fork, state, who, i + 1);
    if (!did) break;
  }

  for (const name of Object.keys(state.accounts) as (keyof State["accounts"])[]) {
    const a = state.accounts[name].address;
    const [jobs] = await fork.pub.readContract({
      address: state.executor,
      abi: gooseExecutorAbi,
      functionName: "accounts",
      args: [a],
    });
    const on = JOBS.filter((_, j) => (jobs & (1 << j)) !== 0);
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

/** Registration: the manager's PermissionApproved since the last one, through registrationOf and registerApproved. */
async function register(fork: Fork, state: State, who: (a: Address) => string) {
  const latest = await fork.pub.getBlockNumber();
  const from = BigInt((state.registeredThrough ?? state.executorBlock) + 1);
  console.log(`Registrations: the manager's PermissionApproved in blocks ${from}–${latest}`);
  const logs =
    from <= latest
      ? await fork.pub.getLogs({ address: MANAGER, event: APPROVED, fromBlock: from, toBlock: latest })
      : [];
  if (!logs.length) console.log("  none");
  for (const log of logs) {
    const permission = log.args.permission;
    if (!permission) continue;
    // The event's data as logged, passed on as one bytes argument, as KeeperHub's runner does.
    const approved = log.data;
    const [ok] = await fork.pub.readContract({
      address: state.executor,
      abi: gooseExecutorAbi,
      functionName: "registrationOf",
      args: [approved],
    });
    if (!ok) {
      console.log(
        `  ${who(permission.account)}: a grant registrationOf doesn't take (not a GooseExecutor template, or stale)`,
      );
      continue;
    }
    const receipt = await fork.send(
      state.forwarder,
      state.executor,
      encodeFunctionData({ abi: gooseExecutorAbi, functionName: "registerApproved", args: [approved] }),
      "registerApproved",
      REGISTER_GAS,
    );
    const lines = describeExecutorLogs(receipt.logs, state.executor, who);
    for (const line of lines.length ? lines : [`${who(permission.account)}: already on`]) console.log(`  ${line}`);
  }
  state.registeredThrough = Number(latest);
  writeState(state);
}

/** One run of the custom-logic upkeep. Returns whether it did anything. */
async function runOnce(fork: Fork, state: State, who: (a: Address) => string, n: number): Promise<boolean> {
  const checkData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [0n, 1n]);
  const [needed, performData] = await fork.pub.readContract({
    address: state.executor,
    abi: gooseExecutorAbi,
    functionName: "checkUpkeep",
    args: [checkData],
    account: state.forwarder,
  });
  console.log(`\nRun ${n}: checkUpkeep(shard 0 of 1)`);
  if (!needed) {
    console.log("  nothing to do");
    for (const name of Object.keys(state.accounts) as (keyof State["accounts"])[]) {
      const p = await fork.pub.readContract({
        address: state.executor,
        abi: gooseExecutorAbi,
        functionName: "planOf",
        args: [state.accounts[name].address],
      });
      if (p.action !== 0)
        console.log(`  ${name}: planOf says ${ACTIONS[p.action]} (${JOBS[p.job]}), not listed this block`);
    }
    return false;
  }
  const [listed] = decodeAbiParameters([{ type: "address[]" }], performData);
  console.log(`  listed: ${listed.map(who).join(", ")}`);
  for (const a of listed) {
    const p = await fork.pub.readContract({
      address: state.executor,
      abi: gooseExecutorAbi,
      functionName: "planOf",
      args: [a],
    });
    console.log(`  ${who(a)} plans ${ACTIONS[p.action]} (${JOBS[p.job]})`);
  }
  const receipt = await fork.send(
    state.forwarder,
    state.executor,
    encodeFunctionData({ abi: gooseExecutorAbi, functionName: "performUpkeep", args: [performData] }),
    "performUpkeep",
    RUN_GAS,
  );
  const lines = describeExecutorLogs(receipt.logs, state.executor, who);
  for (const line of lines.length ? lines : ["the run moved nothing"]) console.log(`  ${line}`);
  console.log(`  performUpkeep ${receipt.transactionHash} (${receipt.gasUsed.toLocaleString("en-US")} gas)`);
  return true;
}

/**
 * The gas a run and a registration are sent with (the upkeeps' limits on Base before the runner, contracts/docs/
 * DEPLOYMENTS.md). Never an estimate: a run with too little gas succeeds by deferring every account, so an estimate
 * finds exactly that.
 */
const RUN_GAS = 5_000_000n;
const REGISTER_GAS = 1_000_000n;

main().catch((e) => {
  console.error(`\nrun-agents failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

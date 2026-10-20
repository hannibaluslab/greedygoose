import { encodeFunctionData } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { isMix } from "@/lib/agents/mix";
import { KEEP_MAX_RAW } from "@/lib/agents/topUps";

/**
 * The agents' settings in GooseExecutor's registry, which only the account itself sets (the executor reads
 * `msg.sender`), each riding in a change's one batch: the Rebalancer's mix, Protect · sell's "Keep my mix" and
 * Rebalance's "Top-ups go into my mix" with Keep as cash.
 */

function executor() {
  if (!GOOSE_EXECUTOR) throw new Error("Agents aren't available yet");
  return GOOSE_EXECUTOR;
}

/** `setMix`: a weight in BPS per stock by reserve id, adding up to 100%. */
export function buildSetMixCalls(user: `0x${string}`, weightsBps: readonly number[]): Call[] {
  if (!isMix(weightsBps) || weightsBps.every((w) => w === 0)) throw new Error("A mix adds up to 100%");
  const weights = weightsBps as unknown as readonly [number, number, number, number, number, number, number];
  return assertAllowed(user, [
    {
      to: executor(),
      data: encodeFunctionData({ abi: gooseExecutorAbi, functionName: "setMix", args: [weights] }),
      value: 0n,
    },
  ]);
}

/** `setKeepMix`: Protect · sell sells the same share of each holding (on), or the most safety per dollar first. */
export function buildSetKeepMixCalls(user: `0x${string}`, on: boolean): Call[] {
  return assertAllowed(user, [
    {
      to: executor(),
      data: encodeFunctionData({ abi: gooseExecutorAbi, functionName: "setKeepMix", args: [on] }),
      value: 0n,
    },
  ]);
}

/**
 * `setTopUps(on, keep)`: top-ups go into the mix (on) or stay as cash, with Keep as cash in USDC units (whole dollars
 * from the app, $0 allowed, at most KEEP_MAX_RAW). The executor counts only once both this and the Rebalancer grant's
 * top-ups flag are set.
 */
export function buildSetTopUpsCalls(user: `0x${string}`, on: boolean, keepRaw: bigint): Call[] {
  if (keepRaw < 0n || keepRaw > KEEP_MAX_RAW) throw new Error("Keep as cash is $0 to $1,000,000");
  return assertAllowed(user, [
    {
      to: executor(),
      data: encodeFunctionData({ abi: gooseExecutorAbi, functionName: "setTopUps", args: [on, Number(keepRaw)] }),
      value: 0n,
    },
  ]);
}

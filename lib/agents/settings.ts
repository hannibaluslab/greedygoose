import { encodeFunctionData } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { isMix } from "@/lib/agents/mix";

/**
 * The agents' settings in GooseExecutor's registry, which only the account itself sets (the executor reads
 * `msg.sender`), each in one Face ID through `useTx`: the Rebalancer's mix and Protect · sell's "Keep my mix".
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
    { to: executor(), data: encodeFunctionData({ abi: gooseExecutorAbi, functionName: "setMix", args: [weights] }), value: 0n },
  ]);
}

/** `setKeepMix`: Protect · sell sells the same share of each holding (on), or the most safety per dollar first. */
export function buildSetKeepMixCalls(user: `0x${string}`, on: boolean): Call[] {
  return assertAllowed(user, [
    { to: executor(), data: encodeFunctionData({ abi: gooseExecutorAbi, functionName: "setKeepMix", args: [on] }), value: 0n },
  ]);
}

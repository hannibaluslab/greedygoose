import { encodeFunctionData } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { GOOSE_GUARD } from "@/lib/agents/config";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { isMix, packMix } from "@/lib/agents/mix";
import { KEEP_MAX_RAW } from "@/lib/agents/topUps";

/**
 * The agents' settings in GooseGuard, which only the account itself sets (the Guard reads `msg.sender`), each riding in
 * a change's one batch: the Rebalancer's mix, Protect · sell's "Keep my mix", Rebalance's "Top-ups go into my mix" with
 * Keep as cash, and the end of a rescue when the user takes credit or repays by hand.
 */

function guard() {
  if (!GOOSE_GUARD) throw new Error("Agents aren't available yet");
  return GOOSE_GUARD;
}

/** `setMix`: a weight in BPS per stock by reserve id, adding up to 100%, packed as the Guard keeps it. */
export function buildSetMixCalls(user: `0x${string}`, weightsBps: readonly number[]): Call[] {
  if (!isMix(weightsBps) || weightsBps.every((w) => w === 0)) throw new Error("A mix adds up to 100%");
  return assertAllowed(user, [
    {
      to: guard(),
      data: encodeFunctionData({ abi: guardAbi, functionName: "setMix", args: [packMix(weightsBps)] }),
      value: 0n,
    },
  ]);
}

/** `setKeepMix`: Protect · sell sells the same share of each holding (on), or the most safety per dollar first. */
export function buildSetKeepMixCalls(user: `0x${string}`, on: boolean): Call[] {
  return assertAllowed(user, [
    {
      to: guard(),
      data: encodeFunctionData({ abi: guardAbi, functionName: "setKeepMix", args: [on] }),
      value: 0n,
    },
  ]);
}

/**
 * `setTopUps(on, keep)`: top-ups go into the mix (on) or stay as cash, with Keep as cash in USDC units (whole dollars
 * from the app, $0 allowed, at most KEEP_MAX_RAW). With them on, the Rebalancer puts the wallet's cash above $1 and
 * above what Keep still needs in savings into the mix (decision 1, the wallet rule). Off, Keep isn't used, so a Keep
 * set past KEEP_MAX_RAW outside the app (the Guard takes any uint48) is sent as KEEP_MAX_RAW: turning top-ups or
 * Rebalance off is never refused over it.
 */
export function buildSetTopUpsCalls(user: `0x${string}`, on: boolean, keepRaw: bigint): Call[] {
  const keep = !on && keepRaw > KEEP_MAX_RAW ? KEEP_MAX_RAW : keepRaw;
  if (keep < 0n || keep > KEEP_MAX_RAW) throw new Error("Keep as cash is $0 to $1,000,000");
  return assertAllowed(user, [
    {
      to: guard(),
      data: encodeFunctionData({ abi: guardAbi, functionName: "setTopUps", args: [on, Number(keep)] }),
      value: 0n,
    },
  ]);
}

/**
 * `endRescue()`, sent by the account in a batch where the user takes more credit or repays by hand (decision 5): the
 * user's own action shows what they want, so Protect stops pushing toward its target. Only while a rescue is on (read
 * with the cash just before signing), so a user with no rescue never sees a Guard call on JAW's sheet. None while no
 * Guard is configured.
 */
export function endRescueCalls(user: `0x${string}`, rescuing: boolean): Call[] {
  if (!GOOSE_GUARD || !rescuing) return [];
  return assertAllowed(user, [
    {
      to: GOOSE_GUARD,
      data: encodeFunctionData({ abi: guardAbi, functionName: "endRescue" }),
      value: 0n,
    },
  ]);
}

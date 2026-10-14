import { encodeFunctionData, type PublicClient, type Transport } from "viem";
import { ENTRY } from "@/config/risk";
import { assertAllowed } from "@/lib/allowlist";
import type { CHAIN } from "@/lib/chain";
import { USDC } from "@/lib/tokens/registry";
import type { EntryCoinAsset } from "@/lib/tokens/stables";
import { aeroQuoterAbi, psm3Abi, quoterV2Abi } from "./abis";
import { approveCall, exactInputCall, swapDeadline, type Call } from "./buy";
import { AERODROME_V1, UNISWAP } from "./venues";

/*
 * Other dollars into cash, signed by the user (D20): a whitelisted coin in the wallet (lib/tokens/stables.ts) is swapped
 * for USDC at the venue the Entry job uses for it, at 99.5% of face value or better, the Entry job's own floor. One
 * batch can convert several coins: an exact approve and a swap each.
 */

type Client = PublicClient<Transport, typeof CHAIN>;

const BPS = 10_000n;
const scale = (coin: EntryCoinAsset) => 10n ** BigInt(coin.decimals - USDC.decimals);

/** Face value of `raw` units of `coin`, in USDC units (rounded down). */
export const faceRaw = (coin: EntryCoinAsset, raw: bigint) => raw / scale(coin);

/**
 * The least USDC converting `amountIn` may bring: face value less ENTRY.floorBps (99.5%), rounded up, as the Entry
 * job's rule has it (lib/guardian/entry.ts planEntry).
 */
export function convertFloorRaw(coin: EntryCoinAsset, amountIn: bigint): bigint {
  const n = amountIn * (BPS - BigInt(ENTRY.floorBps));
  const d = BPS * scale(coin);
  return n === 0n ? 0n : (n - 1n) / d + 1n;
}

/** Below this face value a coin isn't worth a conversion (the Entry job's own minimum). */
export const MIN_CONVERT_RAW = BigInt(Math.round(ENTRY.minEntryUsd * 10 ** USDC.decimals));

/** What converting `amountIn` of `coin` brings now, in USDC units, at its venue. Throws when the venue can't fill it. */
export async function quoteConvert(client: Client, coin: EntryCoinAsset, amountIn: bigint): Promise<bigint> {
  const v = coin.venue;
  if (v.kind === "psm3") {
    return client.readContract({ address: v.psm, abi: psm3Abi, functionName: "previewSwapExactIn", args: [coin.address, USDC.address, amountIn] });
  }
  const { result } =
    v.kind === "aerodrome"
      ? await client.simulateContract({
          address: AERODROME_V1.QUOTER,
          abi: aeroQuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: coin.address, tokenOut: USDC.address, amountIn, tickSpacing: v.tickSpacing, sqrtPriceLimitX96: 0n }],
        })
      : await client.simulateContract({
          address: UNISWAP.QUOTER_V2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: coin.address, tokenOut: USDC.address, amountIn, fee: v.fee, sqrtPriceLimitX96: 0n }],
        });
  return result[0];
}

/** One coin to convert: how much, and the least USDC it may bring (`convertFloorRaw`, or more). */
export type Conversion = { coin: EntryCoinAsset; amountIn: bigint; minOut: bigint };

/**
 * The batch for `conversions`: for each coin an exact approve to its venue, then its swap paying the user at least its
 * `minOut`. Uniswap and Aerodrome carry a deadline, PSM3 swaps at its fixed rate. Every call passes the allowlist.
 */
export function buildConvertCalls(p: { user: `0x${string}`; conversions: readonly Conversion[]; nowSec?: number }): Call[] {
  const deadline = swapDeadline(p.nowSec);
  const calls = p.conversions.flatMap(({ coin, amountIn, minOut }): Call[] => {
    if (amountIn <= 0n) throw new Error("Nothing to convert");
    if (minOut < convertFloorRaw(coin, amountIn)) throw new Error("Under 99.5% of face value");
    const v = coin.venue;
    if (v.kind === "psm3") {
      return [
        approveCall(coin.address, v.psm, amountIn),
        {
          to: v.psm,
          data: encodeFunctionData({ abi: psm3Abi, functionName: "swapExactIn", args: [coin.address, USDC.address, amountIn, minOut, p.user, 0n] }),
          value: 0n,
        },
      ];
    }
    const swap = {
      tokenIn: coin.address,
      tokenOut: USDC.address,
      recipient: p.user,
      amountIn,
      amountOutMinimum: minOut,
      deadline,
    };
    return [
      approveCall(coin.address, v.router, amountIn),
      v.kind === "aerodrome"
        ? exactInputCall({ ...swap, venue: "aerodrome", router: v.router, pool: v.tickSpacing })
        : exactInputCall({ ...swap, venue: "uniswap", router: v.router, pool: v.fee }),
    ];
  });
  return assertAllowed(p.user, calls);
}

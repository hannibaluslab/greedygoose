import type { QueryClient } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import {
  buildConvertCalls,
  convertFloorRaw,
  quoteConvert,
  rateMissingText,
  rateUsable,
  readUsdRate,
  type Conversion,
  type UsdRate,
} from "@/lib/swap/entry";
import type { EntryCoinAsset } from "@/lib/tokens/stables";
import { USDC } from "@/lib/tokens/registry";
import { TxStop, txKey, type TxPlan } from "../prepared";

/** One coin's conversion as the review shows it: all of it, what its venue pays now, and the least it may bring. */
export type ConvertQuote = Conversion & {
  /** USDC units its venue pays now; 0 when it can't fill it. */
  outRaw: bigint;
  /** The venue pays 99.5% of face value or better. */
  fair: boolean;
};

/**
 * One coin's quote: its floor at `rate` (for a coin that isn't a dollar), and fair when the venue pays it. With no
 * usable rate it isn't fair, so it waits like a coin under its price.
 */
export function convertQuote(p: {
  coin: EntryCoinAsset;
  amountIn: bigint;
  outRaw: bigint;
  rate?: UsdRate;
  nowSec: number;
}): ConvertQuote {
  const { coin, amountIn, outRaw, rate, nowSec } = p;
  if (!rateUsable(coin, rate, nowSec)) return { coin, amountIn, minOut: 0n, outRaw, fair: false, rate };
  const minOut = convertFloorRaw(coin, amountIn, rate, nowSec);
  return { coin, amountIn, minOut, outRaw, fair: outRaw >= minOut, rate };
}

/** Shown when no coin can be converted at 99.5% of face value or better right now. */
export const NOT_FAIR = "Not at a fair price right now. It needs 99.5% of face value or better. Try again in a while.";
const CHANGED = "What’s in your account changed since you looked. Check the amounts and try again.";

/**
 * What turning the fair coins of `quotes` into cash signs, in one batch (D20), or null when none is fair. While it's
 * prepared each coin's balance, quote and rate (EURC's) are read again: a balance that moved, a rate that can't be
 * read or is over its age by the latest block's time, or a venue no longer paying 99.5% stops the batch with words, and
 * the card reads its quotes again. A rate that rose since the quote raises that coin's floor to it, never lowers it. Keyed by the coins, their amounts and floors
 * (what a venue pays now only changes the words, not the batch).
 */
export function convertPlan(
  user: `0x${string}`,
  quotes: readonly ConvertQuote[],
  client: Parameters<typeof quoteConvert>[0] | undefined,
  queryClient: Pick<QueryClient, "invalidateQueries">,
): TxPlan | null {
  const shown = quotes.filter((q) => q.fair);
  if (shown.length === 0) return null;
  return {
    key: txKey(
      "convert",
      user,
      shown.map((q) => [q.coin.symbol, q.amountIn, q.minOut]),
    ),
    user,
    calls: async () => {
      const [balances, fresh, rates, block] = await Promise.all([
        Promise.all(
          shown.map((q) =>
            client!.readContract({ address: q.coin.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
          ),
        ),
        Promise.all(shown.map((q) => quoteConvert(client!, q.coin, q.amountIn).catch(() => 0n))),
        Promise.all(shown.map((q) => readUsdRate(client!, q.coin))),
        // A rate's age is measured by Base's clock: a phone's clock that runs slow mustn't pass a feed that stopped.
        shown.some((q) => q.coin.peg) ? client!.getBlock() : null,
      ]);
      const nowSec = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);
      const noRate = shown.find((q, i) => !rateUsable(q.coin, rates[i], nowSec));
      if (noRate) {
        void queryClient.invalidateQueries({ queryKey: ["convertQuote"] });
        throw new TxStop(rateMissingText(noRate.coin));
      }
      const conversions: Conversion[] = shown.map((q, i) => {
        const floor = convertFloorRaw(q.coin, q.amountIn, rates[i], nowSec);
        return { coin: q.coin, amountIn: q.amountIn, minOut: floor > q.minOut ? floor : q.minOut, rate: rates[i] };
      });
      const moved = shown.some((q, i) => balances[i] < q.amountIn);
      const unfair = conversions.some((c, i) => fresh[i] < c.minOut);
      if (moved || unfair) {
        void queryClient.invalidateQueries({ queryKey: moved ? ["readContracts"] : ["convertQuote"] });
        throw new TxStop(moved ? CHANGED : NOT_FAIR);
      }
      return buildConvertCalls({ user, conversions, nowSec });
    },
    fallback: NOT_FAIR,
    activity: shown.map((q) => ({
      kind: "convert" as const,
      symbol: q.coin.symbol,
      amount: Number(q.amountIn) / 10 ** q.coin.decimals,
      receivedUsd: Number(q.outRaw) / 10 ** USDC.decimals,
    })),
  };
}

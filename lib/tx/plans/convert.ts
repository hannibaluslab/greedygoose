import type { QueryClient } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import { buildConvertCalls, quoteConvert, type Conversion } from "@/lib/swap/entry";
import { USDC } from "@/lib/tokens/registry";
import { TxStop, txKey, type TxPlan } from "../prepared";

/** One coin's conversion as the review shows it: all of it, what its venue pays now, and the least it may bring. */
export type ConvertQuote = Conversion & {
  /** USDC units its venue pays now; 0 when it can't fill it. */
  outRaw: bigint;
  /** The venue pays 99.5% of face value or better. */
  fair: boolean;
};

/** Shown when no coin can be converted at 99.5% of face value or better right now. */
export const NOT_FAIR = "Not at a fair price right now: it needs 99.5% of face value or better. Try again in a while.";
const CHANGED = "What’s in your account changed since you looked. Check the amounts and try again.";

/**
 * What turning the fair coins of `quotes` into cash signs, in one batch (D20), or null when none is fair. While it's
 * prepared each coin's balance and quote are read again: a balance that moved, or a venue no longer paying 99.5%,
 * stops the batch with words, and the card reads its quotes again. Keyed by the coins, their amounts and floors (what
 * a venue pays now only changes the words, not the batch).
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
      const [balances, fresh] = await Promise.all([
        Promise.all(
          shown.map((q) =>
            client!.readContract({ address: q.coin.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
          ),
        ),
        Promise.all(shown.map((q) => quoteConvert(client!, q.coin, q.amountIn).catch(() => 0n))),
      ]);
      const moved = shown.some((q, i) => balances[i] < q.amountIn);
      const unfair = shown.some((q, i) => fresh[i] < q.minOut);
      if (moved || unfair) {
        void queryClient.invalidateQueries({ queryKey: moved ? ["readContracts"] : ["convertQuote"] });
        throw new TxStop(moved ? CHANGED : NOT_FAIR);
      }
      return buildConvertCalls({ user, conversions: shown });
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

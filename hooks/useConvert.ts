"use client";

import { erc20Abi } from "viem";
import { usePublicClient } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TxStop, txKey, useTx, type TxPlan } from "@/hooks/useTx";
import { CHAIN_ID } from "@/lib/chain";
import type { Arrived } from "@/lib/cashSetup";
import { buildConvertCalls, convertFloorRaw, quoteConvert, type Conversion } from "@/lib/swap/entry";
import { USDC } from "@/lib/tokens/registry";

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

/** What converting each coin that arrived brings now, at its venue, read every 15 s like a buy's quote while `live`. */
export function useConvertQuotes(arrived: readonly Arrived[], live = true) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["convertQuote", ...arrived.map((a) => `${a.coin.symbol}:${a.raw}`)],
    enabled: !!client && arrived.length > 0 && live,
    refetchInterval: 15_000,
    queryFn: () =>
      Promise.all(
        arrived.map(async ({ coin, raw }): Promise<ConvertQuote> => {
          const minOut = convertFloorRaw(coin, raw);
          const outRaw = await quoteConvert(client!, coin, raw).catch(() => 0n);
          return { coin, amountIn: raw, minOut, outRaw, fair: outRaw >= minOut };
        }),
      ),
  });
}

/**
 * What turning the fair coins of `quotes` into cash signs, in one batch (D20), or null when none is fair. While it's
 * prepared each coin's balance and quote are read again: a balance that moved, or a venue no longer paying 99.5%,
 * stops the batch with words, and the card reads its quotes again. Keyed by the coins, their amounts and floors (what
 * a venue pays now only changes the words, not the batch).
 */
export function convertPlan(
  user: `0x${string}`,
  quotes: readonly ConvertQuote[],
  client: ReturnType<typeof usePublicClient>,
  queryClient: ReturnType<typeof useQueryClient>,
): TxPlan | null {
  const shown = quotes.filter((q) => q.fair);
  if (shown.length === 0) return null;
  return {
    key: txKey("convert", user, shown.map((q) => [q.coin.symbol, q.amountIn, q.minOut])),
    user,
    calls: async () => {
      const [balances, fresh] = await Promise.all([
        Promise.all(shown.map((q) => client!.readContract({ address: q.coin.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }))),
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

/**
 * Turning other dollars into cash, through the one write path (useTx). The card that shows the quotes prepares the
 * batch (`usePrepare(tx.prep, tx.planFor(user, quotes))`, since its quotes pause while JAW's sheet is open) and its
 * tap signs the same plan, straight to JAW's sheet.
 */
export function useConvert() {
  const tx = useTx("This didn’t go through on Base. Your dollars are still in your account.");
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  return { ...tx, planFor: (user: `0x${string}`, quotes: readonly ConvertQuote[]) => convertPlan(user, quotes, client, queryClient) };
}

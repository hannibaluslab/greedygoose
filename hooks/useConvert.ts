"use client";

import { erc20Abi } from "viem";
import { usePublicClient } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TxStop, useTx } from "@/hooks/useTx";
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
 * Turns the fair coins of `quotes` into cash in one batch (D20), through the one write path (useTx). Right before
 * Face ID each coin's balance and quote are read again: a balance that moved, or a venue no longer paying 99.5%, stops
 * the batch with words, and the review reads its quotes again.
 */
export function useConvert() {
  const tx = useTx("This didn’t go through on Base. Your dollars are still in your account.");
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();

  const convert = (user: `0x${string}`, quotes: readonly ConvertQuote[]) => {
    const shown = quotes.filter((q) => q.fair);
    return tx.run(
      user,
      async () => {
        const [balances, fresh] = await Promise.all([
          Promise.all(shown.map((q) => client!.readContract({ address: q.coin.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }))),
          Promise.all(shown.map((q) => quoteConvert(client!, q.coin, q.amountIn).catch(() => 0n))),
        ]);
        const moved = shown.some((q, i) => balances[i] < q.amountIn);
        const unfair = shown.length === 0 || shown.some((q, i) => fresh[i] < q.minOut);
        if (moved || unfair) {
          void queryClient.invalidateQueries({ queryKey: moved ? ["readContracts"] : ["convertQuote"] });
          throw new TxStop(moved ? CHANGED : NOT_FAIR);
        }
        return buildConvertCalls({ user, conversions: shown });
      },
      NOT_FAIR,
      shown.map((q) => ({
        kind: "convert" as const,
        symbol: q.coin.symbol,
        amount: Number(q.amountIn) / 10 ** q.coin.decimals,
        receivedUsd: Number(q.outRaw) / 10 ** USDC.decimals,
      })),
    );
  };
  return { ...tx, convert };
}

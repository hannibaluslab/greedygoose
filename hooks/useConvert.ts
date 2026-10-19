"use client";

import { usePublicClient } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTx } from "@/hooks/useTx";
import { CHAIN_ID } from "@/lib/chain";
import type { Arrived } from "@/lib/cashSetup";
import { quoteConvert, readUsdRate } from "@/lib/swap/entry";
import { convertPlan, convertQuote, type ConvertQuote } from "@/lib/tx/plans";

/**
 * What converting each coin that arrived brings now, at its venue, and its floor (at the euro rate for EURC), read
 * every 15 s like a buy's quote while `live`.
 */
export function useConvertQuotes(arrived: readonly Arrived[], live = true) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["convertQuote", ...arrived.map((a) => `${a.coin.symbol}:${a.raw}`)],
    enabled: !!client && arrived.length > 0 && live,
    refetchInterval: 15_000,
    queryFn: () =>
      Promise.all(
        arrived.map(async ({ coin, raw }): Promise<ConvertQuote> => {
          const [outRaw, rate] = await Promise.all([
            quoteConvert(client!, coin, raw).catch(() => 0n),
            readUsdRate(client!, coin),
          ]);
          return convertQuote({ coin, amountIn: raw, outRaw, rate, nowSec: Math.floor(Date.now() / 1000) });
        }),
      ),
  });
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
  return {
    ...tx,
    planFor: (user: `0x${string}`, quotes: readonly ConvertQuote[]) => convertPlan(user, quotes, client, queryClient),
  };
}

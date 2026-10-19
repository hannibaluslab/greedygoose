"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { useNowSec } from "@/hooks/useNowSec";
import type { Holding } from "@/hooks/usePosition";
import { CHAIN_ID } from "@/lib/chain";
import { blockAt, lastDayEnds, stockGainSeries, type StockDay } from "@/lib/pnl";
import { EQUITIES } from "@/lib/tokens/registry";
import { stockContracts, stocksFrom } from "@/lib/worth";

/** Investments' line covers a week: the last 7 days' ends, then now. */
const DAYS = 7;

/** A settled day's end never changes, so each is read once and kept on the phone: units and prices, EQUITIES order. */
type Kept = Record<string, { u: number[]; p: number[] }>;

const keptKey = (account: Address) => `gg:stockdays:v1:${account.toLowerCase()}`;

function readKept(account: Address): Kept {
  try {
    return (JSON.parse(localStorage.getItem(keptKey(account)) ?? "null") as Kept | null) ?? {};
  } catch {
    return {};
  }
}

function writeKept(account: Address, k: Kept) {
  try {
    localStorage.setItem(keptKey(account), JSON.stringify(k));
  } catch {
    // Private mode or full: read again next time.
  }
}

/**
 * Investments' gain line (lib/pnl stockGainSeries): the stocks held at each of the last 7 days' ends, read at that
 * day's last block (wallet and Aave, at Aave's price, as Home's P&L reads worth), then today's Aave prices from the
 * position. Read one day at a time: Base's public RPC rate-limits.
 */
export function useStockGain(account: Address, holdings: readonly Pick<Holding, "reserveId" | "priceUsd">[]) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const nowSec = useNowSec();
  const today = Math.floor(nowSec / 86_400);

  const { data, isPending, refetch } = useQuery({
    queryKey: ["stock-days", account, today],
    enabled: !!client && nowSec > 0,
    queryFn: async (): Promise<StockDay[]> => {
      const kept = readKept(account);
      const ends = lastDayEnds(DAYS, Math.floor(Date.now() / 1000));
      const missing = ends.filter((t) => !kept[t]);
      if (missing.length > 0) {
        const head = await client!.getBlock();
        // Typed loosely, as usePnl's: 21 typed calls are more than TypeScript will infer (TS2589).
        const multicall = client!.multicall as (args: {
          contracts: readonly unknown[];
          blockNumber: bigint;
          allowFailure: true;
        }) => Promise<Parameters<typeof stocksFrom>[0]>;
        for (const t of missing) {
          const r = await multicall({
            contracts: stockContracts(account),
            blockNumber: blockAt(t, head.number, Number(head.timestamp)),
            allowFailure: true,
          });
          const { units, prices } = stocksFrom(r);
          kept[t] = { u: units, p: prices };
        }
      }
      // Only this week's days stay on the phone.
      writeKept(account, Object.fromEntries(ends.map((t) => [t, kept[t]])));
      return ends.map((t) => ({ t, units: kept[t].u, prices: kept[t].p }));
    },
  });

  return useMemo(() => {
    const retry = () => void refetch();
    if (!data) return { series: null, loading: isPending, retry };
    const last = data[data.length - 1];
    const now = EQUITIES.map((e, i) => holdings.find((h) => h.reserveId === e.reserveId)?.priceUsd ?? last.prices[i]);
    return { series: stockGainSeries(data, now), loading: false, retry };
  }, [data, isPending, refetch, holdings]);
}

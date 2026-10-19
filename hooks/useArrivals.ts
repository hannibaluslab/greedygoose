"use client";

import { useQueries } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import type { ActivityRow } from "@/hooks/useActivity";
import { useTransfersIn } from "@/hooks/useTransfersIn";
import { CHAIN_ID } from "@/lib/chain";
import { arrivalsOf } from "@/lib/activity/arrivals";

/**
 * Money and stocks someone else sent the account since block `from` (none while it's undefined), as Activity rows: the
 * transactions useTransfersIn lists from that block on, each one's receipt, and the time Alchemy gives it. The
 * account's own batches are left out: they are its own moves, and its history has them.
 */
export function useArrivals(account: Address, from: bigint | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const sent = useTransfersIn(from !== undefined ? account : undefined);
  const txs = from === undefined ? [] : (sent.data ?? []).filter((t) => t.block >= from);
  const receipts = useQueries({
    queries: txs.map((t) => ({
      queryKey: ["receipt", t.hash],
      enabled: !!client,
      staleTime: Infinity,
      queryFn: () => client!.getTransactionReceipt({ hash: t.hash }),
    })),
  });

  const rows: ActivityRow[] = txs.flatMap((t, i) => {
    const r = receipts[i]?.data;
    if (!r || r.status !== "success") return [];
    const items = arrivalsOf(r.logs, account, true);
    return items.length
      ? [{ key: `in:${t.hash}`, time: t.t * 1000, status: "done" as const, items, hash: t.hash }]
      : [];
  });

  return {
    rows,
    isLoading: (from !== undefined && sent.isPending) || receipts.some((q) => q.isPending),
    isError: sent.isError || receipts.some((q) => q.isError),
    refetch: () => {
      void sent.refetch();
      for (const q of receipts) if (q.isError) void q.refetch();
    },
  };
}

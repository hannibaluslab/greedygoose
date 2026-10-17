"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useQueries } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useGetCallsHistory } from "@jaw.id/wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { decodeActivity, type ActivityItem } from "@/lib/activity/decode";
import { readLocal, subscribeLocal, type LocalActivity } from "@/lib/activity/local";

export type ActivityRow = {
  key: string;
  time: number;
  status: "pending" | "done" | "failed";
  items: ActivityItem[];
  hash?: `0x${string}`;
};

const EMPTY: LocalActivity[] = [];

/**
 * Activity = JAW's call history for the account (works across devices), each transaction decoded
 * from its Base receipt, plus this device's not-yet-indexed sends.
 */
/** A send's name (sam.justan.id) lives only in this device's record of it: carried onto the receipt's decoded send. */
function withNames(items: ActivityItem[], mine: LocalActivity | undefined): ActivityItem[] {
  if (!mine) return items;
  return items.map((i) => {
    if (i.kind !== "send" || !i.to || i.toName) return i;
    const named = mine.items.find((m) => m.kind === "send" && m.toName && m.to?.toLowerCase() === i.to!.toLowerCase());
    return named ? { ...i, toName: named.toName } : i;
  });
}

export function useActivity(address: `0x${string}`) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const history = useGetCallsHistory({ address, chainId: CHAIN_ID, limit: 30, query: { refetchInterval: 20_000 } });

  const localSnap = useSyncExternalStore(
    subscribeLocal,
    () => JSON.stringify(readLocal(address)),
    () => "[]",
  );
  const local = useMemo(() => (localSnap === "[]" ? EMPTY : (JSON.parse(localSnap) as LocalActivity[])), [localSnap]);

  const entries = useMemo(() => (Array.isArray(history.data) ? history.data : []), [history.data]);
  const receipts = useQueries({
    queries: entries.map((e) => ({
      queryKey: ["receipt", e.transactionHash],
      enabled: !!client && !!e.transactionHash,
      staleTime: Infinity,
      queryFn: () => client!.getTransactionReceipt({ hash: e.transactionHash! }),
    })),
  });

  const rows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = entries.map((e, i) => {
      const r = receipts[i]?.data;
      const mine = local.find((l) => l.id === e.id || (!!l.hash && l.hash === e.transactionHash));
      const items = r ? withNames(decodeActivity(r.logs, address), mine) : [];
      const status = e.status === 100 ? "pending" : e.status === 500 || r?.status === "reverted" ? "failed" : "done";
      return { key: e.id, time: e.timestamp * 1000, status, items, hash: e.transactionHash ?? undefined };
    });
    const known = new Set(out.flatMap((r) => [r.key, r.hash].filter(Boolean)));
    for (const l of local) {
      if (known.has(l.id) || (l.hash && known.has(l.hash))) continue;
      out.push({ key: l.id, time: l.time, status: l.status, items: l.items, hash: l.hash });
    }
    return out.filter((r) => r.items.length > 0 || r.status !== "done").sort((a, b) => b.time - a.time);
  }, [entries, receipts, local, address]);

  return {
    rows,
    isLoading: history.isLoading,
    isError: history.isError && local.length === 0,
    refetch: history.refetch,
  };
}

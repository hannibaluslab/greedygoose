"use client";

import { useMemo } from "react";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlockNumber, usePublicClient } from "wagmi";
import type { Address, Log } from "viem";
import { useActivity } from "@/hooks/useActivity";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useNowSec } from "@/hooks/useNowSec";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { LOG_CHUNK, WEEK_BLOCKS, logChunks } from "@/lib/agents/history";
import { arrivalTxs, arrivalsOf, readArrivalLogs } from "@/lib/activity/arrivals";
import { cashRows, type Arrival } from "@/lib/cashActivity";

/** A chunk this many blocks behind the head is final, and kept (as useAgentFeed keeps its own). */
const SETTLED_BLOCKS = 300n;
/** getLogs requests in flight at once, as useAgentFeed. */
const PARALLEL = 4;
const WEEK_MS = 7 * 86_400_000;

/** Which part couldn't be read: all of it, or some (the rows that were read still show). */
export type CashFeedError = "all" | "some" | null;

/**
 * The Cash sheet's activity for the last 7 days: Activity's own sources filtered to the cash (the user's moves from
 * JAW's history and their receipts, and the executor's moves), plus money someone else sent, read from USDC's Transfer
 * logs to the account in useAgentFeed's chunks. Mounted only while the sheet is open; a chunk the chain has moved past
 * is read once and kept, so opening it again reads only the newest one.
 */
export function useCashActivity(account: Address) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const own = useActivity(account);
  const feed = useAgentFeed(account);
  const head = useBlockNumber({ chainId: CHAIN_ID, query: { refetchInterval: 20_000 } });
  const nowSec = useNowSec();

  // A week back, on a chunk boundary: the executor feed's first week starts on the same block.
  const from = useMemo(() => {
    if (head.data === undefined) return undefined;
    const back = head.data - WEEK_BLOCKS;
    return back > 0n ? (back / LOG_CHUNK) * LOG_CHUNK : 0n;
  }, [head.data]);
  const start = useQuery({
    queryKey: ["blockTime", String(from)],
    enabled: !!client && from !== undefined,
    staleTime: Infinity,
    queryFn: async () => Number((await client!.getBlock({ blockNumber: from! })).timestamp) * 1000,
  });

  const logs = useQuery({
    queryKey: ["cashArrivals", account, String(from), String(head.data)],
    enabled: !!client && from !== undefined,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const to = head.data!;
      const settled = to - SETTLED_BLOCKS;
      const read = (c: { from: bigint; to: bigint }) =>
        queryClient.fetchQuery({
          queryKey: ["cashArrivalChunk", account, String(c.from), String(c.to)],
          staleTime: c.to <= settled ? Infinity : 0,
          gcTime: c.to <= settled ? Infinity : undefined,
          queryFn: () => readArrivalLogs(client!, { account, ...c }),
        });
      const chunks = logChunks(from!, to);
      const out: Log[] = [];
      for (let i = 0; i < chunks.length; i += PARALLEL) out.push(...(await Promise.all(chunks.slice(i, i + PARALLEL).map(read))).flat());
      return arrivalTxs(out);
    },
  });

  // Only the transactions neither the user's history nor the executor's feed has: their receipts and their blocks' time.
  const known = useMemo(
    () => new Set([...own.rows, ...feed.rows].flatMap((r) => (r.hash ? [r.hash.toLowerCase()] : []))),
    [own.rows, feed.rows],
  );
  const txs = useMemo(() => (own.isLoading ? [] : (logs.data ?? []).filter((t) => !known.has(t.hash.toLowerCase()))), [logs.data, known, own.isLoading]);
  const receipts = useQueries({
    queries: txs.map((t) => ({
      queryKey: ["receipt", t.hash],
      enabled: !!client,
      staleTime: Infinity,
      queryFn: () => client!.getTransactionReceipt({ hash: t.hash }),
    })),
  });
  const times = useQueries({
    queries: txs.map((t) => ({
      queryKey: ["blockTime", String(t.blockNumber)],
      enabled: !!client,
      staleTime: Infinity,
      queryFn: async () => Number((await client!.getBlock({ blockNumber: t.blockNumber })).timestamp) * 1000,
    })),
  });

  const arrivals = useMemo<Arrival[]>(
    () =>
      txs.flatMap((t, i) => {
        const r = receipts[i]?.data;
        const time = times[i]?.data;
        return r && time !== undefined && r.status === "success" ? [{ hash: t.hash, time, items: arrivalsOf(r.logs, account) }] : [];
      }),
    [txs, receipts, times, account],
  );

  // Until the window's first block is read, a week back from now (the head can't be read: the RPC is down).
  const since = start.data ?? (head.isError || start.isError ? nowSec * 1000 - WEEK_MS : undefined);
  const rows = useMemo(
    () => (since === undefined ? [] : cashRows({ own: own.rows, executor: feed.rows, arrivals, since })),
    [own.rows, feed.rows, arrivals, since],
  );

  const arrivalsFailed = head.isError || logs.isError || receipts.some((q) => q.isError) || times.some((q) => q.isError);
  const failed = [own.isError, !!GOOSE_EXECUTOR && feed.isError, arrivalsFailed];
  const error: CashFeedError = failed.every((f, i) => f || (i === 1 && !GOOSE_EXECUTOR)) ? "all" : failed.some(Boolean) ? "some" : null;
  const loading =
    own.isLoading ||
    feed.isLoading ||
    head.isPending ||
    (from !== undefined && (logs.isPending || start.isPending)) ||
    receipts.some((q) => q.isPending) ||
    times.some((q) => q.isPending);

  return {
    rows,
    loading: loading && error !== "all",
    error,
    retry: () => {
      void own.refetch();
      feed.refetch();
      void head.refetch();
      void logs.refetch();
      if (start.isError) void start.refetch();
      for (const q of [...receipts, ...times]) if (q.isError) void q.refetch();
    },
  };
}

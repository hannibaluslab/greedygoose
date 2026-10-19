"use client";

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useBlockNumber, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { useActivity } from "@/hooks/useActivity";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useNowSec } from "@/hooks/useNowSec";
import { useTransfersIn } from "@/hooks/useTransfersIn";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { LOG_CHUNK, WEEK_BLOCKS } from "@/lib/agents/history";
import { ALCHEMY_ON } from "@/lib/activity/alchemy";
import { arrivalsOf } from "@/lib/activity/arrivals";
import { cashFeedState, cashRows, type Arrival, type CashFeedError } from "@/lib/cashActivity";

const WEEK_MS = 7 * 86_400_000;

/**
 * The Cash sheet's activity for the last 7 days: Activity's own sources filtered to the cash (the user's moves from
 * JAW's history and their receipts, and the executor's moves), plus money someone else sent (useTransfersIn, USDC
 * only). Mounted only while the sheet is open. Only the first read shows the skeleton: after it, each new read keeps
 * the rows and the notice on screen until it settles (no flicker on a busy RPC).
 */
export function useCashActivity(account: Address) {
  const client = usePublicClient({ chainId: CHAIN_ID });
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

  // Off without Alchemy's key: Base's public RPC refuses getLogs, so the sheet shows the user's own moves alone.
  const sent = useTransfersIn(account);

  // Only the transactions neither the user's history nor the executor's feed has: their receipts and their blocks' time.
  const known = useMemo(
    () => new Set([...own.rows, ...feed.rows].flatMap((r) => (r.hash ? [r.hash.toLowerCase()] : []))),
    [own.rows, feed.rows],
  );
  const txs = useMemo(
    () =>
      own.isLoading || from === undefined
        ? []
        : (sent.data ?? []).filter((t) => t.block >= from && t.usdcRaw > 0n && !known.has(t.hash.toLowerCase())),
    [sent.data, known, own.isLoading, from],
  );
  const receipts = useQueries({
    queries: txs.map((t) => ({
      queryKey: ["receipt", t.hash],
      enabled: !!client,
      staleTime: Infinity,
      queryFn: () => client!.getTransactionReceipt({ hash: t.hash }),
    })),
  });
  const arrivals = useMemo<Arrival[]>(
    () =>
      txs.flatMap((t, i) => {
        const r = receipts[i]?.data;
        return r && r.status === "success"
          ? [{ hash: t.hash, time: t.t * 1000, items: arrivalsOf(r.logs, account) }]
          : [];
      }),
    [txs, receipts, account],
  );

  // Until the window's first block is read, a week back from now (the head can't be read: the RPC is down).
  const since = start.data ?? (head.isError || start.isError ? nowSec * 1000 - WEEK_MS : undefined);
  const rows = useMemo(
    () => (since === undefined ? [] : cashRows({ own: own.rows, executor: feed.rows, arrivals, since })),
    [own.rows, feed.rows, arrivals, since],
  );

  const { live, reading } = cashFeedState({
    executor: !!GOOSE_EXECUTOR,
    arrivals: ALCHEMY_ON,
    windowKnown: from !== undefined,
    own,
    feed,
    head,
    transfers: sent,
    start,
    txReads: receipts,
  });

  // What was shown once everything settled: null until the first read has. A new block's read (a new query, which
  // starts pending when the last one failed) keeps that on screen instead of the skeleton, until it settles too.
  const [settled, setSettled] = useState<{ error: CashFeedError } | null>(null);
  if ((!reading || live === "all") && settled?.error !== live) setSettled({ error: live });
  const error = reading && settled ? settled.error : live;

  return {
    rows,
    loading: settled === null && reading && live !== "all",
    error,
    retry: () => {
      void own.refetch();
      feed.refetch();
      void head.refetch();
      void sent.refetch();
      if (start.isError) void start.refetch();
      for (const q of receipts) if (q.isError) void q.refetch();
    },
  };
}

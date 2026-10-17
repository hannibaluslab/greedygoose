"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlockNumber, usePublicClient } from "wagmi";
import type { Address, Hex, Log } from "viem";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR, GOOSE_EXECUTOR_BLOCK } from "@/lib/agents/config";
import { decodeAgentLogs, type AgentEvent, type AgentLog } from "@/lib/agents/events";
import { describeAgentEvent, type AgentMove, type MoveContext } from "@/lib/agents/feed";
import type { AgentJob } from "@/lib/agents/permissions";
import { LOG_CHUNK, WEEK_BLOCKS, logChunks, readAgentLogs, readMoveContext } from "@/lib/agents/history";

/** A chunk this many blocks behind the head is final, and kept. */
const SETTLED_BLOCKS = 300n;
/** getLogs requests in flight at once. */
const PARALLEL = 4;

/**
 * One agent move in the feed, at `time` (ms), with the transaction that made it, the event it was decoded from and
 * what the chain said around it (the Cash sheet reads the money in them).
 */
export type AgentRow = AgentMove & { key: string; time: number; hash: Hex; event: AgentEvent; ctx: MoveContext };

/** A job's newest switch: on or off, whether the user turned it off, and when (seconds). */
type Switched = { on: boolean; byUser: boolean; at: number };

/** Protect · sell's latest heads-up: what it would sell (USDC units) and when (seconds), sent at `sentAt`. */
export type HeadsUp = { sellValueRaw: bigint; sellAfter: number; sentAt: number };

/**
 * What GooseExecutor did for one account, read from the chain with no indexer (D12): its events indexed by the
 * account, with getLogs in chunks, newest first, then each move's block and the reads around it, a week at a time
 * back to the executor's deploy block. Nothing is read until an executor is configured.
 */
export function useAgentFeed(account: Address) {
  const executor = GOOSE_EXECUTOR;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const [weeks, setWeeks] = useState(1);
  const head = useBlockNumber({ chainId: CHAIN_ID, query: { enabled: !!executor, refetchInterval: 20_000 } });

  // On a chunk boundary, so the window's oldest chunk is the same request until the head crosses the next one.
  const from = useMemo(() => {
    if (head.data === undefined) return undefined;
    const back = head.data - BigInt(weeks) * WEEK_BLOCKS;
    const aligned = back > 0n ? (back / LOG_CHUNK) * LOG_CHUNK : 0n;
    return aligned > GOOSE_EXECUTOR_BLOCK ? aligned : GOOSE_EXECUTOR_BLOCK;
  }, [head.data, weeks]);

  const logs = useQuery({
    queryKey: ["agentLogs", executor, account, String(from), String(head.data)],
    enabled: !!executor && !!client && from !== undefined,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const to = head.data!;
      const settled = to - SETTLED_BLOCKS;
      const read = (c: { from: bigint; to: bigint }) =>
        queryClient.fetchQuery({
          queryKey: ["agentLogChunk", executor, account, String(c.from), String(c.to)],
          staleTime: c.to <= settled ? Infinity : 0,
          gcTime: c.to <= settled ? Infinity : undefined,
          queryFn: () => readAgentLogs(client!, { executor: executor!, account, ...c }),
        });
      const chunks = logChunks(from!, to);
      const out: Log[] = [];
      for (let i = 0; i < chunks.length; i += PARALLEL)
        out.push(...(await Promise.all(chunks.slice(i, i + PARALLEL).map(read))).flat());
      return decodeAgentLogs(out, executor!, account).sort((a, b) =>
        a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
      );
    },
  });

  // A run deferred to the next block isn't a move: nothing to read for it.
  const events = useMemo(() => (logs.data ?? []).filter((e) => e.kind !== "run-deferred"), [logs.data]);
  const moves = useQueries({
    queries: events.map((e: AgentLog) => ({
      queryKey: ["agentMove", executor, e.key],
      enabled: !!client,
      staleTime: Infinity,
      queryFn: () => readMoveContext(client!, { executor: executor!, account }, e),
    })),
  });

  // When the window starts, so the feed shows no older moves of the user's own until it reads that far back.
  const more = from !== undefined && from > GOOSE_EXECUTOR_BLOCK;
  const start = useQuery({
    queryKey: ["blockTime", String(from)],
    enabled: !!client && more,
    staleTime: Infinity,
    queryFn: async () => Number((await client!.getBlock({ blockNumber: from! })).timestamp) * 1000,
  });

  const rows = useMemo<AgentRow[]>(
    () =>
      events.flatMap((e, i) => {
        const m = moves[i]?.data;
        const move = m && describeAgentEvent(e, m.time, m.ctx);
        return move ? [{ ...move, key: e.key, time: m.time * 1000, hash: e.txHash, event: e, ctx: m.ctx }] : [];
      }),
    [events, moves],
  );

  const headsUp = useMemo<HeadsUp | null>(() => {
    const i = events.findIndex((e) => e.kind === "heads-up");
    const e = events[i];
    const m = moves[i]?.data;
    return e?.kind === "heads-up" && m
      ? { sellValueRaw: e.sellValueRaw, sellAfter: e.sellAfter, sentAt: m.time }
      : null;
  }, [events, moves]);

  // Each job's newest switch: on, or off by the user (revoked) or by the executor (its grant ran out, it can't act, or
  // its runs kept failing).
  const switched = useMemo(() => {
    const out: Partial<Record<AgentJob, Switched>> = {};
    const seen = new Set<AgentJob>();
    events.forEach((e, i) => {
      if ((e.kind !== "job-on" && e.kind !== "job-off") || seen.has(e.job)) return;
      seen.add(e.job);
      const time = moves[i]?.data?.time; // until its block is read, the job waits rather than show an older switch
      if (time)
        out[e.job] = { on: e.kind === "job-on", byUser: e.kind === "job-off" && e.reason === "revoked", at: time };
    });
    return out;
  }, [events, moves]);

  if (!executor) {
    return {
      rows: [],
      headsUp: null,
      switched: {} as Partial<Record<AgentJob, Switched>>,
      since: 0,
      more: false,
      showEarlier: () => {},
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
  }
  return {
    rows,
    headsUp,
    /** Each job's newest switch in the weeks read so far. */
    switched,
    /** The user's own moves older than this (ms) wait for "Show earlier", so the two lists cover the same days. */
    since: more ? (start.data ?? 0) : 0,
    /** Whether there are older weeks to read. */
    more,
    showEarlier: () => setWeeks((w) => w + 1),
    isLoading: head.isPending || logs.isPending || moves.some((q) => q.isPending) || (more && start.isPending),
    isError: head.isError || logs.isError || moves.some((q) => q.isError) || start.isError,
    refetch: () => {
      void head.refetch();
      void logs.refetch();
      for (const q of moves) if (q.isError) void q.refetch();
      if (start.isError) void start.refetch();
    },
  };
}

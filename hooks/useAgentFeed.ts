"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlockNumber, usePublicClient } from "wagmi";
import type { Address, Hex, Log } from "viem";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_GUARD, GOOSE_GUARD_BLOCK } from "@/lib/agents/config";
import { decodeAgentLogs, type AgentEvent, type AgentLog } from "@/lib/agents/events";
import { collapseRefused, describeAgentEvent, type AgentMove, type MoveContext } from "@/lib/agents/feed";
import type { ProtectNumbers } from "@/lib/agents/lines";
import { useProtectNumbers } from "@/hooks/useProtectNumbers";
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

/**
 * What GooseGuard did for one account, read from the chain with no indexer (D12): its events indexed by the account,
 * with getLogs in chunks, newest first, then each move's block and the reads around it, a week at a time back to the
 * Guard's deploy block. Nothing is read until a Guard is configured.
 */
export function useAgentFeed(account: Address) {
  const now = useProtectNumbers(account);
  const guard = GOOSE_GUARD;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const [weeks, setWeeks] = useState(1);
  const head = useBlockNumber({ chainId: CHAIN_ID, query: { enabled: !!guard, refetchInterval: 20_000 } });

  // On a chunk boundary, so the window's oldest chunk is the same request until the head crosses the next one.
  const from = useMemo(() => {
    if (head.data === undefined) return undefined;
    const back = head.data - BigInt(weeks) * WEEK_BLOCKS;
    const aligned = back > 0n ? (back / LOG_CHUNK) * LOG_CHUNK : 0n;
    return aligned > GOOSE_GUARD_BLOCK ? aligned : GOOSE_GUARD_BLOCK;
  }, [head.data, weeks]);

  const logs = useQuery({
    queryKey: ["agentLogs", guard, account, String(from), String(head.data)],
    enabled: !!guard && !!client && from !== undefined,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const to = head.data!;
      const settled = to - SETTLED_BLOCKS;
      const read = (c: { from: bigint; to: bigint }) =>
        queryClient.fetchQuery({
          queryKey: ["agentLogChunk", guard, account, String(c.from), String(c.to)],
          staleTime: c.to <= settled ? Infinity : 0,
          gcTime: c.to <= settled ? Infinity : undefined,
          queryFn: () => readAgentLogs(client!, { guard: guard!, account, ...c }),
        });
      const chunks = logChunks(from!, to);
      const out: Log[] = [];
      for (let i = 0; i < chunks.length; i += PARALLEL)
        out.push(...(await Promise.all(chunks.slice(i, i + PARALLEL).map(read))).flat());
      return decodeAgentLogs(out, guard!, account).sort((a, b) =>
        a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
      );
    },
  });

  // Each agent's refusals in a row are one row, the newest, with their count; the rest are read as they are.
  // Protect's own numbers as set over time make no row and need no read: they only say which applied to each move.
  const events = useMemo(() => collapseRefused((logs.data ?? []).filter((e) => e.kind !== "lines-set")), [logs.data]);
  const moves = useQueries({
    queries: events.map((e: AgentLog) => ({
      queryKey: ["agentMove", guard, e.key],
      enabled: !!client,
      staleTime: Infinity,
      queryFn: () => readMoveContext(client!, { account }, e),
    })),
  });

  // When the window starts, so the feed shows no older moves of the user's own until it reads that far back.
  const more = from !== undefined && from > GOOSE_GUARD_BLOCK;
  const start = useQuery({
    queryKey: ["blockTime", String(from)],
    enabled: !!client && more,
    staleTime: Infinity,
    queryFn: async () => Number((await client!.getBlock({ blockNumber: from! })).timestamp) * 1000,
  });

  // The line and target each move ran under (decision 3): the last `setProtect` read before it. With none before it,
  // today's, which held all along unless one came after it (then the older ones are past what was read).
  const inForce = useMemo(() => {
    const sets = (logs.data ?? []).filter((e) => e.kind === "lines-set");
    const before = (e: AgentLog, s: AgentLog) =>
      s.blockNumber < e.blockNumber || (s.blockNumber === e.blockNumber && s.logIndex < e.logIndex);
    return events.map((e): ProtectNumbers => {
      const s = sets.find((x) => before(e, x)); // newest first: the last one before the move
      return s && s.kind === "lines-set" ? { line: s.line, target: s.target } : now;
    });
  }, [logs.data, events, now]);

  const rows = useMemo<AgentRow[]>(
    () =>
      events.flatMap((e, i) => {
        const m = moves[i]?.data;
        const move = m && describeAgentEvent(e, m.ctx, inForce[i]);
        return move ? [{ ...move, key: e.key, time: m.time * 1000, hash: e.txHash, event: e, ctx: m.ctx }] : [];
      }),
    [events, moves, inForce],
  );

  // Each job's newest switch: on, or off by the user (only the account itself unregisters a job in the Guard).
  const switched = useMemo(() => {
    const out: Partial<Record<AgentJob, Switched>> = {};
    const seen = new Set<AgentJob>();
    events.forEach((e, i) => {
      if ((e.kind !== "job-on" && e.kind !== "job-off") || seen.has(e.job)) return;
      seen.add(e.job);
      const time = moves[i]?.data?.time; // until its block is read, the job waits rather than show an older switch
      if (time) out[e.job] = { on: e.kind === "job-on", byUser: e.kind === "job-off", at: time };
    });
    return out;
  }, [events, moves]);

  if (!guard) {
    return {
      rows: [],
      events: [] as typeof events,
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
    /** The events read so far, newest first, each agent's refusals in a row as one (`collapseRefused`). */
    events,
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

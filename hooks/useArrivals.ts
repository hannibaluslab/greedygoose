"use client";

import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address, Hex, Log } from "viem";
import type { ActivityRow } from "@/hooks/useActivity";
import { CHAIN_ID } from "@/lib/chain";
import { logChunks } from "@/lib/agents/history";
import {
  RECEIVED_TOKENS,
  arrivalTxs,
  arrivalsOf,
  rangesToScan,
  rateLimited,
  readArrivalLogs,
  type ScannedArrivals,
} from "@/lib/activity/arrivals";

/** Blocks this far behind the head are final: scanned once and kept on the phone. */
const SETTLED_BLOCKS = 300n;
/** getLogs requests in flight at once: Base's public RPC rate-limits more. */
const PARALLEL = 2;
/** A rate-limited range waits and asks again, up to this many times, before the read fails. */
const RETRIES = 5;

const keptKey = (account: Address) => `gg:arrivals:${account.toLowerCase()}`;

function readKept(account: Address): ScannedArrivals | null {
  try {
    const raw = localStorage.getItem(keptKey(account));
    if (!raw) return null;
    const k = JSON.parse(raw) as { lo: string; hi: string; txs: { hash: Hex; blockNumber: string }[] };
    return {
      lo: BigInt(k.lo),
      hi: BigInt(k.hi),
      txs: k.txs.map((t) => ({ hash: t.hash, blockNumber: BigInt(t.blockNumber) })),
    };
  } catch {
    return null;
  }
}

function writeKept(account: Address, k: ScannedArrivals) {
  try {
    localStorage.setItem(
      keptKey(account),
      JSON.stringify({
        lo: String(k.lo),
        hi: String(k.hi),
        txs: k.txs.map((t) => ({ hash: t.hash, blockNumber: String(t.blockNumber) })),
      }),
    );
  } catch {
    // Private mode or full: scanned again next time.
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Money and stocks someone else sent the account since block `from` (none while it's undefined), as Activity rows: the USDC and stock Transfer
 * logs to it (lib/activity/arrivals), each transaction's receipt and its block's time. Settled blocks are scanned once
 * and what they held is kept on the phone, so a new visit or "Show earlier" reads only blocks never read; a range the
 * RPC rate-limits waits and asks again. The account's own batches are left out: they are its own moves, and its history
 * has them.
 */
export function useArrivals(account: Address, from: bigint | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });

  const logs = useQuery({
    // Not keyed on the head: a first scan outlasts a block or two, and each new head would start it over.
    queryKey: ["arrivals", account, String(from)],
    enabled: !!client && from !== undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
    retry: false,
    queryFn: async () => {
      const read = async (c: { from: bigint; to: bigint }): Promise<Log[]> => {
        for (let n = 0; ; n++) {
          try {
            return await readArrivalLogs(client!, { account, ...c, tokens: RECEIVED_TOKENS });
          } catch (e) {
            if (!rateLimited(e) || n >= RETRIES) throw e;
            await wait(1_000 * (n + 1));
          }
        }
      };
      const head = await client!.getBlockNumber();
      const settled = head - SETTLED_BLOCKS;
      const start = readKept(account);
      const kept: ScannedArrivals = start ?? { lo: from!, hi: from! - 1n, txs: [] };
      // Settled blocks, a few ranges at a time, saved after each so a scan cut short goes on from there next time:
      // upwards from the kept stretch's top, then (Show earlier) downwards from its bottom.
      for (const r of rangesToScan(from!, settled, start)) {
        const down = !!start && r.to < start.lo;
        const chunks = logChunks(r.from, r.to);
        if (!down) chunks.reverse();
        for (let i = 0; i < chunks.length; i += PARALLEL) {
          const batch = chunks.slice(i, i + PARALLEL);
          const found = arrivalTxs((await Promise.all(batch.map(read))).flat());
          const seen = new Set(kept.txs.map((t) => t.hash));
          kept.txs.push(...found.filter((t) => !seen.has(t.hash)));
          if (down) kept.lo = batch.reduce((lo, c) => (c.from < lo ? c.from : lo), kept.lo);
          else kept.hi = batch.reduce((hi, c) => (c.to > hi ? c.to : hi), kept.hi);
          writeKept(account, kept);
        }
      }
      // The newest blocks aren't final yet: read each time, never kept.
      const recent =
        settled < head ? arrivalTxs((await Promise.all(logChunks(settled + 1n, head).map(read))).flat()) : [];
      const seen = new Set(recent.map((t) => t.hash));
      return [...recent, ...kept.txs.filter((t) => t.blockNumber >= from! && !seen.has(t.hash))].sort((x, y) =>
        x.blockNumber === y.blockNumber ? 0 : x.blockNumber > y.blockNumber ? -1 : 1,
      );
    },
  });

  const txs = logs.data ?? [];
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

  const rows: ActivityRow[] = txs.flatMap((t, i) => {
    const r = receipts[i]?.data;
    const time = times[i]?.data;
    if (!r || time === undefined || r.status !== "success") return [];
    const items = arrivalsOf(r.logs, account, true);
    return items.length ? [{ key: `in:${t.hash}`, time, status: "done" as const, items, hash: t.hash }] : [];
  });

  return {
    rows,
    isLoading:
      (from !== undefined && logs.isPending) || receipts.some((q) => q.isPending) || times.some((q) => q.isPending),
    isError: logs.isError || receipts.some((q) => q.isError) || times.some((q) => q.isError),
    refetch: () => {
      void logs.refetch();
      for (const q of [...receipts, ...times]) if (q.isError) void q.refetch();
    },
  };
}

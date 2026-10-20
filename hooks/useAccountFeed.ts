"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBlockNumber, usePublicClient } from "wagmi";
import type { FeedError } from "@/components/gg/Agents";
import type { FeedRow } from "@/components/gg/activity/Activity";
import { useActivity } from "@/hooks/useActivity";
import type { useAgentFeed } from "@/hooks/useAgentFeed";
import { useArrivals } from "@/hooks/useArrivals";
import { ALCHEMY_ON } from "@/lib/activity/alchemy";
import { APP_START_BLOCK } from "@/lib/activity/arrivals";
import { LOG_CHUNK, WEEK_BLOCKS } from "@/lib/agents/history";
import { CHAIN_ID } from "@/lib/chain";

/**
 * Everything that happened in the account, newest first: the user's own moves (JAW's history), the executor's (`feed`:
 * the agents' moves, and the cash's own events, D20), and money or stocks someone else sent (useArrivals), over the
 * same days, with what couldn't be read. Arrivals go back a week at a time, as the executor's feed does, down to the
 * first block GreedyGoo could have been used in. The Agents tab and Activity draw it with AgentsFeed.
 */
export function useAccountFeed(address: `0x${string}`, feed: ReturnType<typeof useAgentFeed>) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const yours = useActivity(address);
  const head = useBlockNumber({ chainId: CHAIN_ID, query: { refetchInterval: 20_000 } });
  const [weeks, setWeeks] = useState(1);
  // `weeks` back, on a chunk boundary (so settled chunks are kept), never before the app's first block.
  const from = useMemo(() => {
    if (head.data === undefined) return undefined;
    const back = head.data - BigInt(weeks) * WEEK_BLOCKS;
    const start = back > 0n ? (back / LOG_CHUNK) * LOG_CHUNK : 0n;
    return start > APP_START_BLOCK ? start : APP_START_BLOCK;
  }, [head.data, weeks]);
  // Off without Alchemy's key: Base's public RPC refuses getLogs.
  const arrivals = useArrivals(address, ALCHEMY_ON ? from : undefined);
  const olderArrivals = ALCHEMY_ON && from !== undefined && from > APP_START_BLOCK;
  const start = useQuery({
    queryKey: ["blockTime", String(from)],
    enabled: !!client && olderArrivals,
    staleTime: Infinity,
    queryFn: async () => Number((await client!.getBlock({ blockNumber: from! })).timestamp) * 1000,
  });
  // Every list covers the same days: from the later of the windows' starts.
  const since = Math.max(feed.since, olderArrivals ? (start.data ?? 0) : 0);

  const rows = useMemo<FeedRow[]>(() => {
    const own = new Set(yours.rows.flatMap((r) => (r.hash ? [r.hash.toLowerCase()] : [])));
    return [
      ...feed.rows.filter((r) => r.time >= since),
      ...yours.rows.filter((r) => r.time >= since),
      ...arrivals.rows.filter((r) => r.time >= since && !own.has(r.hash!.toLowerCase())),
    ].sort((a, b) => b.time - a.time);
  }, [feed.rows, yours.rows, arrivals.rows, since]);
  // What others sent fails as the executor's rows do: some of the activity, not the user's own moves.
  const theirs = feed.isError || arrivals.isError;
  const error: FeedError = yours.isError && theirs ? "all" : theirs ? "agents" : yours.isError ? "yours" : null;
  return {
    rows,
    loading: yours.isLoading || feed.isLoading || arrivals.isLoading || (olderArrivals && start.isPending),
    error,
    onRetry: () => {
      void yours.refetch();
      feed.refetch();
      arrivals.refetch();
    },
    more: feed.more || olderArrivals,
    onShowEarlier: () => {
      feed.showEarlier();
      setWeeks((w) => w + 1);
    },
  };
}

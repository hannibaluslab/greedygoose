"use client";

import { useMemo } from "react";
import type { FeedError } from "@/components/gg/Agents";
import type { FeedRow } from "@/components/gg/Activity";
import { useActivity } from "@/hooks/useActivity";
import type { useAgentFeed } from "@/hooks/useAgentFeed";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";

/**
 * Everything that happened in the account, newest first: the user's own moves (JAW's history) and the executor's
 * (`feed`: the agents' moves, and the cash's own events, D20), over the same days, with what couldn't be read. The
 * Agents tab and Activity draw it with AgentsFeed.
 */
export function useAccountFeed(address: `0x${string}`, feed: ReturnType<typeof useAgentFeed>) {
  const yours = useActivity(address);
  // The user's own moves cover the same days as the executor's moves read so far.
  const rows = useMemo<FeedRow[]>(
    () => [...feed.rows, ...yours.rows.filter((r) => r.time >= feed.since)].sort((a, b) => b.time - a.time),
    [feed.rows, feed.since, yours.rows],
  );
  const error: FeedError = yours.isError && (feed.isError || !GOOSE_EXECUTOR) ? "all" : feed.isError ? "agents" : yours.isError ? "yours" : null;
  return {
    rows,
    loading: yours.isLoading || feed.isLoading,
    error,
    onRetry: () => {
      void yours.refetch();
      feed.refetch();
    },
    more: feed.more,
    onShowEarlier: feed.showEarlier,
  };
}

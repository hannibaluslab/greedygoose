"use client";

import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http } from "viem";
import { usePublicClient } from "wagmi";
import { CHAIN, CHAIN_ID } from "@/lib/chain";
import { BOARD_LOGS_RPC, GOOSE_BOARD } from "@/lib/board/config";
import { readBoard } from "@/lib/board/read";

/** The board's log reader (lib/board/config.ts): the app's own RPC when set, else PublicNode's. */
const logsClient = createPublicClient({ chain: CHAIN, transport: http(BOARD_LOGS_RPC, { retryCount: 2 }) });

/**
 * The whole leaderboard, read from the chain in this browser (no server, D12) and refreshed every minute. Disabled
 * until GooseBoard is configured. A failed read is an error, never a partial board.
 */
export function useBoard() {
  const state = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["board", GOOSE_BOARD],
    queryFn: () => readBoard({ state: state!, logs: logsClient, board: GOOSE_BOARD! }),
    enabled: !!GOOSE_BOARD && !!state,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

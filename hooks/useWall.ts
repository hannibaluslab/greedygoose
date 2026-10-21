"use client";

import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http } from "viem";
import { usePublicClient } from "wagmi";
import { CHAIN, CHAIN_ID } from "@/lib/chain";
import { BOARD_LOGS_RPC, GOOSE_BOARD, WALL_FROM_BLOCK } from "@/lib/board/config";
import { readWall } from "@/lib/board/read";

/** The Wall's log reader: the board's (lib/board/config.ts). */
const logsClient = createPublicClient({ chain: CHAIN, transport: http(BOARD_LOGS_RPC, { retryCount: 2 }) });

/**
 * Greedy Fatalities, read from the chain in this browser (no server, D12) and refreshed every minute, as the board is.
 * Disabled until the Wall is open (WALL_FROM_BLOCK). A failed read is an error, never a partial Wall.
 */
export function useWall() {
  const state = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["wall", GOOSE_BOARD, WALL_FROM_BLOCK?.toString()],
    queryFn: () => readWall({ state: state!, logs: logsClient, board: GOOSE_BOARD!, from: WALL_FROM_BLOCK! }),
    enabled: !!GOOSE_BOARD && WALL_FROM_BLOCK !== undefined && !!state,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

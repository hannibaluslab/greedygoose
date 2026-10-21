import { useBlockNumber, useReadContract } from "wagmi";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { summarize, type AccountData } from "@/lib/aave/math";

/** Base makes a block every 2 seconds, so a day is 43,200 blocks. */
const DAY_BLOCKS = 43_200n;

/**
 * The credit health 24 hours ago (Adrian, 2026-10-22: "+/- points in the past 24h"): Aave's own `getUserAccountData`
 * read at the block a day back, so it counts every change, prices and repays and credit taken. null while it loads,
 * when nothing was owed then, or when the node can't read that far back.
 */
export function useHealthDayAgo(who: `0x${string}` | undefined): number | null {
  const head = useBlockNumber({ query: { staleTime: 10 * 60_000, refetchInterval: false } });
  const then = head.data !== undefined ? head.data - DAY_BLOCKS : undefined;
  const read = useReadContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "getUserAccountData",
    args: who ? [who] : undefined,
    blockNumber: then,
    query: { enabled: !!who && then !== undefined, staleTime: 10 * 60_000, retry: 1 },
  });
  return read.data ? summarize(read.data as unknown as AccountData).healthFactor : null;
}

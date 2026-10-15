"use client";

import { useReadContract } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";

/**
 * When stock prices next freeze, in seconds, on GooseExecutor's own calendar (`nextFreeze`: 20:00 New York before a
 * weekend or a holiday it holds; the time asked itself while prices are already held). Null until the executor is
 * configured and read. For the weekend heads-up card (Act is the line, 2026-10-15).
 *
 * Asked for the start of the current hour, so the read changes once an hour rather than every minute. That's exact:
 * a freeze starts on the hour (20:00 New York is a whole UTC hour), so one later in this hour can't be missed, and one
 * that started at the top of it comes back as the hour itself, which is not after now.
 */
export function useNextFreeze(nowSec: number): number | null {
  const executor = GOOSE_EXECUTOR;
  const hour = Math.floor(nowSec / 3_600) * 3_600;
  const q = useReadContract({
    address: executor,
    abi: gooseExecutorAbi,
    chainId: CHAIN_ID,
    functionName: "nextFreeze",
    args: [BigInt(hour)],
    query: { enabled: !!executor && nowSec > 0, staleTime: 3_600_000 },
  });
  return q.data === undefined ? null : Number(q.data);
}

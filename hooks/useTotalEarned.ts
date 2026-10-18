"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { useAccountMoves } from "@/hooks/useAccountMoves";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";
import { aUsdcEarnAbi, sinceLastMoveRaw, type SavingsMove } from "@/lib/earned";

const usd = (raw: bigint) => Number(raw) / 10 ** USDC.decimals;

/**
 * What the cash has earned in savings (lib/earned): the account's savings moves (useAccountMoves: every batch it sent,
 * kept on the phone) and what has built up since the last one, read with the balance so the two match. The Yield card
 * shows it all time; its sheet by period. `readAt` is when that read landed: both count on from it.
 */
export function useTotalEarned(account: Address | undefined) {
  const history = useAccountMoves(account);
  const closed = useMemo(() => {
    if (!history.data) return undefined;
    const kept = history.data.filter((k) => k.inc !== "0" || k.net !== "0");
    return {
      closedRaw: kept.reduce((a, k) => a + BigInt(k.inc), 0n),
      moves: kept.map((k): SavingsMove => ({ t: k.t, inc: usd(BigInt(k.inc)), net: usd(BigInt(k.net)) })),
    };
  }, [history.data]);

  const open = useReadContracts({
    contracts: account
      ? ([
          { address: PROTOCOLS.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [account] },
          { address: PROTOCOLS.AUSDC, abi: aUsdcEarnAbi, functionName: "scaledBalanceOf", args: [account] },
          { address: PROTOCOLS.AUSDC, abi: aUsdcEarnAbi, functionName: "getPreviousIndex", args: [account] },
        ] as const)
      : [],
    allowFailure: false,
    query: { enabled: !!account, refetchInterval: 15_000 },
  });

  if (closed === undefined || !open.data) return { data: undefined, isError: history.isError || open.isError };
  const [balance, scaled, previousIndex] = open.data as readonly [bigint, bigint, bigint];
  const openRaw = sinceLastMoveRaw(balance, scaled, previousIndex);
  return {
    data: {
      /** All time, as of `readAt`. */
      usd: usd(closed.closedRaw + openRaw),
      /** The savings moves in time order, and the interest built up since the last one (as of `readAt`). */
      moves: closed.moves,
      openUsd: usd(openRaw),
      readAt: open.dataUpdatedAt,
    },
    isError: false,
  };
}

export type TotalEarned = NonNullable<ReturnType<typeof useTotalEarned>["data"]>;

"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useReadContracts } from "wagmi";
import { handleGetCallsHistoryRequest } from "@jaw.id/core";
import { erc20Abi, type Address } from "viem";
import { CHAIN_ID } from "@/lib/chain";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";
import { aUsdcEarnAbi, moveIn, sinceLastMoveRaw, type SavingsMove } from "@/lib/earned";

const usd = (raw: bigint) => Number(raw) / 10 ** USDC.decimals;

/** Bundles per page of JAW's history. */
const PAGE = 50;
/** Receipts read at once. */
const PARALLEL = 4;

// v2: each batch keeps when it went, its interest and what went in or out (the Yield sheet's periods need them).
const cacheKey = (account: Address) => `gg:earned:v2:${account.toLowerCase()}`;

/** One batch's savings move as kept: raw USDC as strings, `t` from JAW's history. */
type Kept = { t: number; inc: string; net: string };

/** Each batch's savings move, by transaction: a mined batch never changes, so it's read once per phone. */
function readCache(account: Address): Record<string, Kept> {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(account)) ?? "{}") as Record<string, Kept>;
  } catch {
    return {};
  }
}

function writeCache(account: Address, cache: Record<string, Kept>) {
  try {
    localStorage.setItem(cacheKey(account), JSON.stringify(cache));
  } catch {
    // Private mode or full: it's read again next time.
  }
}

/**
 * What the cash has earned in savings (lib/earned): the account's savings moves (JAW's history, every page, and each
 * batch's Base receipt, kept on the phone) and what has built up since the last one, read with the balance so the two
 * match. The Yield card shows it all time; its sheet by period. `readAt` is when that read landed: both count on from it.
 */
export function useTotalEarned(account: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });

  const closed = useQuery({
    queryKey: ["earned-closed", account],
    enabled: !!account && !!client,
    refetchInterval: 60_000,
    queryFn: async () => {
      const who = account!;
      const batches: { hash: `0x${string}`; t: number }[] = [];
      const seen = new Set<number>();
      let index: number | undefined;
      for (;;) {
        // JAW's own history call, by address: it needs no wallet connection, so it runs as soon as Home does.
        const page = await handleGetCallsHistoryRequest(
          {
            method: "wallet_getCallsHistory",
            params: [
              { address: who, chainId: CHAIN_ID, limit: PAGE, sort: "asc", ...(index === undefined ? {} : { index }) },
            ],
          },
          process.env.NEXT_PUBLIC_JAW_API_KEY,
        );
        const fresh = page.filter((b) => !seen.has(b.index));
        for (const b of fresh) {
          seen.add(b.index);
          if (b.transactionHash && b.status === 200) batches.push({ hash: b.transactionHash, t: b.timestamp });
        }
        if (page.length < PAGE || fresh.length === 0) break;
        index = page[page.length - 1].index;
      }
      const cache = readCache(who);
      const missing = batches.filter((b) => !(b.hash in cache));
      for (let i = 0; i < missing.length; i += PARALLEL) {
        const part = missing.slice(i, i + PARALLEL);
        const receipts = await Promise.all(part.map((b) => client!.getTransactionReceipt({ hash: b.hash })));
        receipts.forEach((r, j) => {
          const m = moveIn(r.logs, who);
          cache[r.transactionHash] = { t: part[j].t, inc: m.inc.toString(), net: m.net.toString() };
        });
      }
      if (missing.length) writeCache(who, cache);
      const kept = batches.map((b) => cache[b.hash]).filter((k) => k && (k.inc !== "0" || k.net !== "0"));
      return {
        closedRaw: kept.reduce((a, k) => a + BigInt(k.inc), 0n),
        moves: kept
          .map((k): SavingsMove => ({ t: k.t, inc: usd(BigInt(k.inc)), net: usd(BigInt(k.net)) }))
          .sort((a, b) => a.t - b.t),
      };
    },
  });

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

  if (closed.data === undefined || !open.data) return { data: undefined, isError: closed.isError || open.isError };
  const [balance, scaled, previousIndex] = open.data as readonly [bigint, bigint, bigint];
  const openRaw = sinceLastMoveRaw(balance, scaled, previousIndex);
  return {
    data: {
      /** All time, as of `readAt`. */
      usd: usd(closed.data.closedRaw + openRaw),
      /** The savings moves in time order, and the interest built up since the last one (as of `readAt`). */
      moves: closed.data.moves,
      openUsd: usd(openRaw),
      readAt: open.dataUpdatedAt,
    },
    isError: false,
  };
}

export type TotalEarned = NonNullable<ReturnType<typeof useTotalEarned>["data"]>;

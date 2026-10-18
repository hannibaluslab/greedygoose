"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useReadContracts } from "wagmi";
import { handleGetCallsHistoryRequest } from "@jaw.id/core";
import { erc20Abi, type Address } from "viem";
import { CHAIN_ID } from "@/lib/chain";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";
import { aUsdcEarnAbi, interestIn, sinceLastMoveRaw } from "@/lib/earned";

/** Bundles per page of JAW's history. */
const PAGE = 50;
/** Receipts read at once. */
const PARALLEL = 4;

const cacheKey = (account: Address) => `gg:earned:${account.toLowerCase()}`;

/** Each batch's interest, by transaction: a mined batch never changes, so it's read once per phone. */
function readCache(account: Address): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(account)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeCache(account: Address, cache: Record<string, string>) {
  try {
    localStorage.setItem(cacheKey(account), JSON.stringify(cache));
  } catch {
    // Private mode or full: it's read again next time.
  }
}

/**
 * The Yield card's total earned (lib/earned): the interest Aave closed at each of the account's savings moves (JAW's
 * history, every page, and each batch's Base receipt, kept on the phone) plus what has built up since the last move,
 * read with the balance so the two match. `readAt` is when that read landed: the card counts on from it.
 */
export function useTotalEarned(account: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });

  const closed = useQuery({
    queryKey: ["earned-closed", account],
    enabled: !!account && !!client,
    refetchInterval: 60_000,
    queryFn: async () => {
      const who = account!;
      const hashes: `0x${string}`[] = [];
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
          if (b.transactionHash && b.status === 200) hashes.push(b.transactionHash);
        }
        if (page.length < PAGE || fresh.length === 0) break;
        index = page[page.length - 1].index;
      }
      const cache = readCache(who);
      const missing = hashes.filter((h) => !(h in cache));
      for (let i = 0; i < missing.length; i += PARALLEL) {
        const receipts = await Promise.all(
          missing.slice(i, i + PARALLEL).map((hash) => client!.getTransactionReceipt({ hash })),
        );
        receipts.forEach((r) => (cache[r.transactionHash] = interestIn(r.logs, who).toString()));
      }
      if (missing.length) writeCache(who, cache);
      return hashes.reduce((a, h) => a + BigInt(cache[h] ?? "0"), 0n);
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
  const raw = closed.data + sinceLastMoveRaw(balance, scaled, previousIndex);
  return {
    data: { usd: Number(raw) / 10 ** USDC.decimals, readAt: open.dataUpdatedAt },
    isError: false,
  };
}

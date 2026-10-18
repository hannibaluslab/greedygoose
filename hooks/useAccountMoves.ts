"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { handleGetCallsHistoryRequest } from "@jaw.id/core";
import type { Address, Hex } from "viem";
import { CHAIN_ID } from "@/lib/chain";
import { decodeActivity } from "@/lib/activity/decode";
import { moveIn } from "@/lib/earned";

/** Bundles per page of JAW's history. */
const PAGE = 50;
/** Receipts read at once. */
const PARALLEL = 4;

/**
 * One of the account's own batches, as kept on the phone: when it went (`t`, JAW's history; `b`, its block), the
 * savings interest it closed and what it put in or took out of savings (raw USDC, lib/earned), what it sent out (`out`:
 * each send's symbol and amount, dollars for USDC, shares for a stock) and the dollars other coins became (`conv`).
 */
type AccountMove = {
  hash: Hex;
  t: number;
  b: string;
  inc: string;
  net: string;
  out: { s: string; a: number }[];
  conv: number;
};

// v1 of the shared record (the Yield total kept its own as gg:earned:v2 before; this one reads the same receipts once).
const cacheKey = (account: Address) => `gg:moves:v1:${account.toLowerCase()}`;

function readCache(account: Address): Record<string, AccountMove> {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(account)) ?? "{}") as Record<string, AccountMove>;
  } catch {
    return {};
  }
}

function writeCache(account: Address, cache: Record<string, AccountMove>) {
  try {
    localStorage.setItem(cacheKey(account), JSON.stringify(cache));
  } catch {
    // Private mode or full: read again next time.
  }
}

/**
 * Every batch the account sent, all time: JAW's history (every page; it needs no wallet connection) and each batch's
 * Base receipt, read once per phone. The Yield total (savings moves) and P&L (what was sent out, what other coins
 * became) read from it.
 */
export function useAccountMoves(account: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["account-moves", account],
    enabled: !!account && !!client,
    refetchInterval: 60_000,
    queryFn: async (): Promise<AccountMove[]> => {
      const who = account!;
      const batches: { hash: Hex; t: number }[] = [];
      const seen = new Set<number>();
      let index: number | undefined;
      for (;;) {
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
          const items = r.status === "success" ? decodeActivity(r.logs, who) : [];
          cache[r.transactionHash] = {
            hash: r.transactionHash,
            t: part[j].t,
            b: r.blockNumber.toString(),
            inc: m.inc.toString(),
            net: m.net.toString(),
            out: items.filter((x) => x.kind === "send").map((x) => ({ s: x.symbol, a: x.amount })),
            conv: items.filter((x) => x.kind === "convert").reduce((a, x) => a + (x.receivedUsd ?? 0), 0),
          };
        });
      }
      if (missing.length) writeCache(who, cache);
      return batches.flatMap((b) => (cache[b.hash] ? [cache[b.hash]] : [])).sort((x, y) => x.t - y.t);
    },
  });
}

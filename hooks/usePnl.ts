"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { useAccountMoves } from "@/hooks/useAccountMoves";
import { useNowSec } from "@/hooks/useNowSec";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { AAVE } from "@/lib/aave/addresses";
import { priceToUsd } from "@/lib/aave/math";
import { ALCHEMY_ON, transfersIn } from "@/lib/activity/alchemy";
import { arrivalsOf } from "@/lib/activity/arrivals";
import { CHAIN_ID } from "@/lib/chain";
import { blockAt, dayEnds, pnlAllTime, pnlSeries, type Flow, type WorthPoint } from "@/lib/pnl";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { worthContracts, worthFrom } from "@/lib/worth";

/** Reads at once: Base's public RPC rate-limits more. */
const PARALLEL = 2;

/** What's kept on the phone, per account: settled things only, so none of it is ever read again. */
type Kept = {
  /** Money or stocks someone sent, by transaction: when, its block, and what came (symbol, amount). */
  in: Record<string, { t: number; b: string; items: { s: string; a: number }[] }>;
  /** A stock's Aave price at a block, by "reserveId:block". */
  px: Record<string, number>;
  /** The account's worth at the end of each UTC day, by its last second. */
  worth: Record<string, number>;
};

const keptKey = (account: Address) => `gg:pnl:v1:${account.toLowerCase()}`;

function readKept(account: Address): Kept {
  try {
    const k = JSON.parse(localStorage.getItem(keptKey(account)) ?? "null") as Kept | null;
    return k ?? { in: {}, px: {}, worth: {} };
  } catch {
    return { in: {}, px: {}, worth: {} };
  }
}

function writeKept(account: Address, k: Kept) {
  try {
    localStorage.setItem(keptKey(account), JSON.stringify(k));
  } catch {
    // Private mode or full: read again next time.
  }
}

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(run));
}

/**
 * All-time P&L for Home (lib/pnl): the money put in and taken out, and the account's worth at each day's end since the
 * first money in. Put in: USDC and stocks someone sent (Alchemy's Transfers API, then each transaction's receipt, which
 * leaves out the account's own batches) and other coins turned into cash; taken out: what the account sent. Stocks are
 * valued at Aave's price at the block they moved. Worth is read at each day's last block, as Home reads it now. Off
 * without Alchemy's key: without the money others sent, a top-up would read as profit.
 */
export function usePnl(account: Address | undefined, worthNowUsd: number | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const moves = useAccountMoves(ALCHEMY_ON ? account : undefined);
  const nowSec = useNowSec();

  const read = useQuery({
    queryKey: ["pnl", account, moves.data?.length],
    enabled: ALCHEMY_ON && !!account && !!client && !!moves.data,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const who = account!;
      const kept = readKept(who);
      const own = new Set(moves.data!.map((m) => m.hash.toLowerCase()));

      // Money and stocks someone sent: each transaction once, its receipt deciding what it brought.
      const incoming = (await transfersIn(who)).filter((x) => !own.has(x.hash.toLowerCase()) && !kept.in[x.hash]);
      await inBatches(incoming, async (x) => {
        const r = await client!.getTransactionReceipt({ hash: x.hash });
        const items = r.status === "success" ? arrivalsOf(r.logs, who, true) : [];
        kept.in[x.hash] = { t: x.t, b: x.block.toString(), items: items.map((i) => ({ s: i.symbol, a: i.amount })) };
      });

      // Each stock that moved, at Aave's price at that block.
      const usdOf = async (symbol: string, amount: number, block: string) => {
        if (symbol === USDC.symbol) return amount;
        const stock = EQUITIES.find((e) => e.symbol === symbol);
        if (!stock) return 0;
        const k = `${stock.reserveId}:${block}`;
        if (kept.px[k] === undefined) {
          const raw = await client!.readContract({
            address: AAVE.SPOKE_ORACLE,
            abi: aaveOracleAbi,
            functionName: "getReservePrice",
            args: [BigInt(stock.reserveId)],
            blockNumber: BigInt(block),
          });
          kept.px[k] = priceToUsd(raw);
        }
        return amount * kept.px[k];
      };
      const flows: Flow[] = [];
      for (const m of moves.data!) {
        if (m.conv > 0) flows.push({ t: m.t, usd: m.conv });
        for (const o of m.out) flows.push({ t: m.t, usd: -(await usdOf(o.s, o.a, m.b)) });
      }
      for (const x of Object.values(kept.in))
        for (const i of x.items) flows.push({ t: x.t, usd: await usdOf(i.s, i.a, x.b) });

      // The worth at each day's end since the first money in, read at that day's last block.
      const first = flows.filter((f) => f.usd > 0).sort((a, b) => a.t - b.t)[0];
      const head = await client!.getBlock();
      const headSec = Number(head.timestamp);
      const ends = first ? dayEnds(first.t, headSec).filter((t) => kept.worth[t] === undefined) : [];
      await inBatches(ends, async (t) => {
        // Typed loosely: 24 typed calls are more than TypeScript will infer (TS2589).
        const multicall = client!.multicall as (args: {
          contracts: readonly unknown[];
          blockNumber: bigint;
          allowFailure: true;
        }) => Promise<Parameters<typeof worthFrom>[0]>;
        const r = await multicall({
          contracts: worthContracts(who),
          blockNumber: blockAt(t, head.number, headSec),
          allowFailure: true,
        });
        kept.worth[t] = worthFrom(r);
      });
      writeKept(who, kept);
      const days: WorthPoint[] = Object.entries(kept.worth).map(([t, worthUsd]) => ({ t: Number(t), worthUsd }));
      return { flows, days };
    },
  });

  return useMemo(() => {
    if (!ALCHEMY_ON) return { on: false as const };
    if (!read.data || worthNowUsd === undefined)
      return { on: true as const, data: undefined, isError: read.isError || moves.isError };
    const pnl = pnlAllTime(worthNowUsd, read.data.flows, nowSec);
    return {
      on: true as const,
      data: pnl && { ...pnl, series: pnlSeries(read.data.days, read.data.flows, worthNowUsd, nowSec) },
      isError: false,
    };
  }, [read.data, read.isError, moves.isError, worthNowUsd, nowSec]);
}

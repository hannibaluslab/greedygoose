"use client";

import { useSearchParams } from "next/navigation";
import { AgentsFeed, AgentsView, HeadsUpCard } from "@/components/gg/Agents";
import type { AgentRow } from "@/hooks/useAgentFeed";
import { useNowSec } from "@/hooks/useNowSec";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, type MoveContext } from "@/lib/agents/feed";
import { agentList } from "@/lib/agents/list";

// The Agents board's own figures, for the dev pair only. Nothing here reads the chain: each row is an executor event
// put through the app's own words (describeAgentEvent), with what the chain would say around it.
const WAD = 10n ** 18n;
const hf = (x: number) => (BigInt(Math.round(x * 1000)) * WAD) / 1000n;
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
/** Aave's prices: Apple $250, NVIDIA $180, Tesla $383 (8 decimals, by reserve id). */
const PRICES = [250e8, 0, 0, 0, 0, 180e8, 383e8].map(BigInt);
const seven = (r: number, raw: bigint) => Array.from({ length: 7 }, (_, i) => (i === r ? raw : 0n));
const ZERO_TX = `0x${"0".repeat(64)}` as const;

/** Today at the board's 3:12 AM and 2:41 AM, and two days back at 10:05 AM, from `now` (ms). */
function rows(now: number): AgentRow[] {
  const at = (daysBack: number, h: number, m: number) => new Date(now).setHours(h, m, 0, 0) / 1000 - daysBack * 86_400;
  const moves: [string, number, AgentEvent, MoveContext][] = [
    [
      "sale",
      at(0, 3, 12),
      { kind: "sold", sharesRaw: seven(6, 46_997_389n), repaidRaw: usdc(178.2), hfBefore: hf(1.08), hfAfter: hf(1.52), atOnce: true },
      { owedRaw: [usdc(780), usdc(600)], cashRaw: [usdc(400), usdc(400)], used: { spentRaw: usdc(180), capRaw: usdc(300), decimals: 6 }, pricesRaw: PRICES },
    ],
    ["heads-up", at(0, 2, 41), { kind: "heads-up", hf: hf(1.24), sellValueRaw: usdc(180), sellAfter: at(0, 3, 11) }, {}],
    [
      "rebalance",
      at(2, 10, 5),
      { kind: "rebalanced", soldRaw: seven(0, 20_000_000n), boughtRaw: seven(5, 27_777_778n) },
      { cashRaw: [usdc(400), usdc(400)], used: { spentRaw: usdc(50), capRaw: usdc(500), decimals: 6 }, pricesRaw: PRICES },
    ],
  ];
  return moves.map(([key, time, e, ctx]) => ({ ...describeAgentEvent(e, time, ctx)!, key, time: time * 1000, hash: ZERO_TX }));
}

const LIST = agentList({
  status: { save: "on", protect: "on", sell: "on", rebalance: "on", entry: "off" },
  capRaw: { save: usdc(1000), protect: usdc(300), sell: usdc(300), rebalance: usdc(500), entry: null },
  credit: "safe",
  onTarget: true,
});

export function AgentsBoard() {
  const headsUp = useSearchParams().get("headsup") === "1";
  const now = useNowSec() * 1000;
  return (
    <AgentsView
      headsUp={headsUp && <HeadsUpCard add="$120" sell="$180" when="in 30 min" status="watch" />}
      agents={LIST.agents}
      reason={LIST.reason}
      feed={<AgentsFeed rows={rows(now)} nowMs={now} loading={false} error={null} onRetry={() => {}} more={false} onShowEarlier={() => {}} />}
    />
  );
}

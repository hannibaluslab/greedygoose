"use client";

import { useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { FeedCard, FeedDays } from "@/components/gg/activity/Activity";
import { AgentSheet } from "@/components/gg/AgentSheet";
import { AgentRow, AgentsFeed, AgentsView, AttentionCard, MixBar, TurnOffAll } from "@/components/gg/Agents";
import type { AgentRow as FeedAgentRow } from "@/hooks/useAgentFeed";
import { useNowSec } from "@/hooks/useNowSec";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, type MoveContext } from "@/lib/agents/feed";
import {
  AGENT_JOBS,
  AGENT_NAME,
  agentCards,
  agentItems,
  longDateText,
  TAB_JOBS,
  type Agent,
  type AgentItem,
} from "@/lib/agents/list";
import { rebalanceOptions } from "@/lib/agents/mix";
import { agentNexts, defaultNumbers, type NextInput } from "@/lib/agents/next";
import { JOBS, startCapRaw, type AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { ProtectDemo } from "../ProtectDemos";
import { RebalanceStateBody } from "../RebalanceDemo";

/*
 * Dev only: the Agents tab in each state it can be in, with fixtures run through the app's own rules and words
 * (agentNexts, agentItems, agentCards, describeAgentEvent). Nothing here reads the chain or the executor.
 *   /dev/ui/agents                live, all fine: no cards
 *   ?view=cards                   every card
 *   ?view=rows                    each row state
 *   ?view=notlive                 today: no executor configured
 *   &sheet=protect|rebalance      a sheet open
 * Every switch, Renew and Turn off goes straight to JAW's own sheet in the app; here it only says so.
 */

const NOTHING_SIGNED = () => toast("Dev gallery: nothing is signed");

const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const WAD = 10n ** 18n;
const hf = (x: number) => (BigInt(Math.round(x * 1000)) * WAD) / 1000n;
const ZERO_TX = `0x${"0".repeat(64)}` as const;
const shares = (usd: number, price: number) => BigInt(Math.round((usd / price) * 1e8));
const priceRaw = (usd: number) => BigInt(Math.round(usd * 1e8));
const byJob = <T,>(f: (job: AgentJob) => T) =>
  Object.fromEntries(JOBS.map((job) => [job, f(job)])) as Record<AgentJob, T>;

/** Free shares at Aave's price: NVIDIA, Apple and Tesla at 50/25/25 of $10,000, the mix they're kept at. */
const PRICES = [222.22, 0, 0, 0, 0, 178.57, 378.38];
const FREE_USD = [2_500, 0, 0, 0, 0, 5_000, 2_500];
const HOLDINGS = PRICES.map((p, reserveId) => ({
  reserveId,
  priceRaw: priceRaw(p),
  freeRaw: p ? shares(FREE_USD[reserveId], p) : 0n,
}));
const MIX = [2_500, 0, 0, 0, 0, 5_000, 2_500];

/** The executor's CAP_MAX here: Protect's grants are at it (no amount limit), the Rebalancer's at its $100 a week. */
const CAP_MAX = usdc(10_000);

/** $400 of cash earning, $600 owed against $2,000 of backing: Safe. */
function nextInput(nowSec: number, over: Partial<NextInput> = {}): NextInput {
  return {
    nowSec,
    savingsRaw: usdc(400),
    totalBackingUsd: 2_000,
    avgCf: 0.7,
    debtUsd: 600,
    holdings: HOLDINGS,
    mixBps: MIX,
    left: byJob(() => null),
    capRaw: caps,
    capMaxRaw: CAP_MAX,
    numbers: defaultNumbers(rebalanceOptions()),
    rebalanceDay: 0,
    rescuing: false,
    sellOn: true,
    pricesHeld: false,
    plan: null,
    ...over,
  };
}

const all = (s: AgentStatus) => byJob(() => s);
const caps = byJob((job) => startCapRaw(job, CAP_MAX));

/**
 * What the agents did, and the cash events: today $40 arriving, a repay from cash and a sale that went on until 1.12
 * after the credit fell under 1.03, two days back a rebalance and 120 USDT arriving.
 */
function feedRows(nowMs: number): FeedAgentRow[] {
  const at = (daysBack: number, h: number, m: number) =>
    new Date(nowMs).setHours(h, m, 0, 0) / 1000 - daysBack * 86_400;
  const prices = PRICES.map(priceRaw);
  const seven = (r: number, raw: bigint) => Array.from({ length: 7 }, (_, i) => (i === r ? raw : 0n));
  const moves: [string, number, AgentEvent, MoveContext][] = [
    ["save", at(0, 9, 40), { kind: "saved", amountRaw: usdc(40) }, {}],
    [
      "sale",
      at(0, 3, 12),
      {
        kind: "sold",
        sharesRaw: seven(6, shares(180, 378.38)),
        repaidRaw: usdc(178.2),
        hfBefore: hf(1.06),
        hfAfter: hf(1.12),
      },
      { owedRaw: [usdc(780), usdc(600)], cashRaw: [usdc(0), usdc(1.8)], pricesRaw: prices },
    ],
    [
      "repay",
      at(0, 3, 2),
      { kind: "repaid", amountRaw: usdc(40), hfBefore: hf(1.02), hfAfter: hf(1.06) },
      { owedRaw: [usdc(820), usdc(780)], cashRaw: [usdc(40), usdc(0)] },
    ],
    [
      "rebalance",
      at(2, 10, 5),
      { kind: "rebalanced", soldRaw: seven(0, shares(250, 222.22)), boughtRaw: seven(5, shares(250, 178.57)) },
      { cashRaw: [usdc(400), usdc(401.12)], used: { spentRaw: usdc(250), capRaw: usdc(500) }, pricesRaw: prices },
    ],
    [
      "convert",
      at(2, 8, 30),
      { kind: "converted", coin: ENTRY_COINS[0].address, amountInRaw: usdc(120), usdcOutRaw: usdc(119.83) },
      {},
    ],
  ];
  return moves.map(([key, time, e, ctx]) => ({
    ...describeAgentEvent(e, time, ctx)!,
    key,
    time: time * 1000,
    hash: ZERO_TX,
    event: e,
    ctx,
  }));
}

type View = "live" | "cards" | "rows" | "notlive";

export function AgentsGallery() {
  const params = useSearchParams();
  const router = useRouter();
  const nowSec = useNowSec();
  const nowMs = nowSec * 1000;
  const view = (["cards", "rows", "notlive"].includes(params.get("view") ?? "") ? params.get("view") : "live") as View;
  const [sheet, setSheet] = useState<Agent | null>(() => {
    const a = params.get("sheet") as Agent | null;
    return a && a in AGENT_JOBS ? a : null;
  });
  if (!nowSec) return null;

  const live = view !== "notlive";
  const rows = feedRows(nowMs);

  // Each view's agents: their jobs' states, and what the rules say they do next.
  const cardsView = view === "cards";
  const status: Record<AgentJob, AgentStatus> = !live
    ? all("unconfigured")
    : cardsView
      ? { ...all("on"), rebalance: "off" }
      : all("on");
  // Without an executor there's no registry, so no mix.
  const input = nextInput(nowSec, { mixBps: live ? MIX : null });
  const items = agentItems({
    status,
    capRaw: live ? byJob((job) => (status[job] === "off" ? null : caps[job])) : byJob(() => null),
    next: agentNexts(input),
  });

  const cards = cardsView
    ? agentCards({
        nowSec,
        act: { addUsd: 120, protectOn: true },
        weekend: { addUsd: 40, dropPct: 15, when: "at 8:00 PM" },
        status,
        ends: byJob((job) =>
          job === "protect" || job === "sell"
            ? nowSec + 5 * 86_400
            : status[job] === "off"
              ? null
              : nowSec + 200 * 86_400,
        ),
        stopped: byJob((job) => (job === "rebalance" ? nowSec - 2 * 86_400 : null)),
        fails: 3,
        cooldownUntil: nowSec + 20 * 60,
        // Earning's grant whose registration didn't go through: the Finish card.
        finish: ["save"],
      })
    : [];

  // One JAW sheet for each of Protect's and Rebalance's grants that's on: Protect's two on the cards view, all three otherwise.
  const allOffSteps = live ? TAB_JOBS.filter((j) => status[j] !== "off").length : 0;
  const row = (item: AgentItem, mix = live) => (
    <AgentRow
      key={`${item.agent}-${item.status}`}
      item={item}
      live={live}
      switchable={live && item.status !== "loading"}
      onOpen={() => setSheet(item.agent)}
      onSwitch={NOTHING_SIGNED}
      extra={item.agent === "rebalance" && mix ? <MixBar mixBps={MIX} /> : undefined}
    />
  );

  return (
    <>
      <AgentsView
        live={live}
        signed={live && status.rebalance !== "off"}
        cards={cards.map((c) => (
          <AttentionCard key={c.key} card={c} onRenew={NOTHING_SIGNED} />
        ))}
        rows={
          view === "rows" ? (
            <RowStates nowSec={nowSec} row={(item) => row(item, false)} />
          ) : (
            items.map((item) => row(item))
          )
        }
        feed={
          <AgentsFeed
            empty="Nothing yet. What your agents do shows up here, with why."
            rows={live ? rows : []}
            nowMs={nowMs}
            loading={false}
            error={null}
            onRetry={() => {}}
            more={false}
            onShowEarlier={() => {}}
          />
        }
        turnOffAll={allOffSteps > 0 && <TurnOffAll steps={allOffSteps} disabled={false} onClick={NOTHING_SIGNED} />}
      />
      {sheet && (
        <GallerySheet
          agent={sheet}
          item={items.find((i) => i.agent === sheet)!}
          live={live}
          nowSec={nowSec}
          rows={rows}
          onClose={() => {
            setSheet(null);
            router.replace(`/dev/ui/agents${view === "live" ? "" : `?view=${view}`}`);
          }}
        />
      )}
    </>
  );
}

/** Each state a row can be in, each with the line the app gives it. */
function RowStates({ nowSec, row }: { nowSec: number; row: (item: AgentItem) => ReactNode }) {
  const next = agentNexts(nextInput(nowSec, { mixBps: null }));
  const states: [string, AgentStatus][] = [
    ["Not live yet", "unconfigured"],
    ["Loading", "loading"],
    ["Off", "off"],
    ["Starting", "starting"],
    ["On", "on"],
  ];
  return states.map(([label, s]) => (
    <div key={s} className="flex flex-col gap-2">
      <span className="label px-1">{label}</span>
      {agentItems({ status: all(s), capRaw: byJob((job) => (s === "on" || s === "starting" ? caps[job] : null)), next })
        .filter((i) => s !== "on" || i.agent !== "rebalance")
        .map(row)}
    </div>
  ));
}

function GallerySheet({
  agent,
  item,
  live,
  nowSec,
  rows,
  onClose,
}: {
  agent: Agent;
  item: AgentItem;
  live: boolean;
  nowSec: number;
  rows: FeedAgentRow[];
  onClose: () => void;
}) {
  const name = AGENT_NAME[agent];
  const activity = rows.filter((r) => r.by === name);
  return (
    <AgentSheet
      open
      onClose={onClose}
      item={item}
      live={live}
      busy={false}
      error={null}
      offSteps={AGENT_JOBS[agent].length}
      stops={item.on ? longDateText(nowSec + 200 * 86_400) : null}
      settings={
        // The real settings bodies, drawn from their fixtures (ProtectDemos, RebalanceDemo).
        agent === "protect" ? (
          <ProtectDemo state={!live ? "not-live" : item.status === "off" ? "off" : "on"} />
        ) : (
          <RebalanceStateBody state={!live ? "not-live" : item.status === "off" ? "switch-on" : "on-target"} />
        )
      }
      activity={
        <FeedCard>
          {live && activity.length ? (
            <FeedDays rows={activity} nowMs={nowSec * 1000} />
          ) : (
            <p className="m-0 py-3.5 text-sm text-ink-mid">Nothing yet.</p>
          )}
        </FeedCard>
      }
      onAction={NOTHING_SIGNED}
    />
  );
}

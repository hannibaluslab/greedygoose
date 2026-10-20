"use client";

import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { RebalanceCard, RebalanceCardView } from "@/components/gg/agents/RebalanceCard";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { useNowSec } from "@/hooks/useNowSec";
import { rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import { nyDay, rebalanceOutlook } from "@/lib/agents/next";
import {
  rebalanceCard,
  type CardTopUps,
  type RebalanceCardInput,
  type RebalanceCardModel,
} from "@/lib/agents/rebalanceCard";

/*
 * Dev only: Rebalance's overview card in every state, the first that applies, with fixtures run through the app's own
 * rule and words (rebalanceOutlook, rebalanceCard). Nothing here reads the chain.
 *   /dev/ui/agents/rebalance              every state
 *   /dev/ui/agents/rebalance?as=0x…       the real card for that account on top (read only), then every state
 * A tap on a card would open Rebalance's sheet; here it only says so.
 */

const OPEN = () => toast("Dev gallery: Rebalance’s sheet opens here");

/** Aave's prices, by reserve id: Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla. */
const PRICES = [250, 220, 180, 700, 500, 180, 400];
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const CAP_MAX = usdc(1_000_000);

/** $10,000 of free stock, `pcts` of it in each stock by reserve id. */
const holdings = (pcts: readonly number[]): MixHolding[] =>
  PRICES.map((p, reserveId) => ({
    reserveId,
    priceRaw: BigInt(Math.round(p * 1e8)),
    freeRaw: BigInt(Math.round(((pcts[reserveId] / 100) * 10_000 * 1e8) / p)),
  }));

/** The boards' mix: Apple 20, Amazon 10, Alphabet 10, Meta 10, Microsoft 15, NVIDIA 25, Tesla 10. */
const MIX = [2_000, 1_000, 1_000, 1_000, 1_500, 2_500, 1_000];
/** Board 7a: all inside their bands, NVIDIA a little high (26%), Tesla a little low (9%). */
const ON_TARGET = [20, 10, 10, 10, 15, 26, 9];
/** "Coin hop": NVIDIA out of the top of its band (32%), Apple (16%) and Meta (8%) at the bottom of theirs. */
const DRIFTED = [16, 10, 10, 8, 15, 32, 9];
/** NVIDIA and Tesla at 60/40. */
const TWO = [0, 0, 0, 0, 0, 6_000, 4_000];

/**
 * Top-ups on: $`usd` counted yesterday, with Keep $500 and enough savings above it, so all of it goes in at the next
 * check (lib/agents/rebalanceCard.ts investDue, the contract's rule).
 */
const counted = (now: number, usd: number): CardTopUps => ({
  state: {
    day: nyDay(now) - 1,
    keepRaw: usdc(500),
    readyRaw: usdc(usd),
    todayRaw: 0n,
    markRaw: usdc(usd + 1_000),
    ownRaw: 0n,
  },
  savingsRaw: usdc(usd + 1_000),
  usdcLeftRaw: CAP_MAX,
  savingsLeftRaw: CAP_MAX,
});

type Fixture = {
  pcts?: readonly number[];
  mixBps?: readonly number[] | null;
  /** What's owed against $2,000 of backing at a 70% factor: $600 is Safe, $1,300 is in Act. */
  debtUsd?: number;
  card?: Partial<RebalanceCardInput>;
};

function model(nowSec: number, f: Fixture = {}): RebalanceCardModel | null {
  const h = holdings(f.pcts ?? ON_TARGET);
  const mixBps = f.mixBps === undefined ? MIX : f.mixBps;
  const options = rebalanceOptions();
  const outlook = rebalanceOutlook({
    nowSec,
    holdings: h,
    mixBps,
    capMaxRaw: CAP_MAX,
    rebalanceDay: 0,
    debtUsd: f.debtUsd ?? 600,
    totalBackingUsd: 2_000,
    avgCf: 0.7,
    left: { rebalance: null },
    capRaw: { rebalance: CAP_MAX },
    numbers: { rebalance: options },
  });
  return rebalanceCard({
    live: true,
    nowSec,
    status: "on",
    waiting: false,
    stoppedAt: null,
    endsAt: nowSec + 200 * 86_400,
    fails: 0,
    cooldownUntil: 0,
    rebalanceDay: 0,
    holdings: h,
    mixBps,
    options,
    outlook,
    ...f.card,
  });
}

const DAY = 86_400;
const STATES: [string, (now: number) => Fixture | "loading"][] = [
  ["On target (board 7a)", () => ({})],
  ["Trades due (Coin hop): NVIDIA past its band", () => ({ pcts: DRIFTED })],
  ["Trades due: a two-stock mix, both past their bands", () => ({ pcts: [0, 0, 0, 0, 0, 70, 30], mixBps: TWO })],
  [
    "Top-up going in: $300 into a two-stock mix on target",
    (now) => ({ pcts: [0, 0, 0, 0, 0, 60, 40], mixBps: TWO, card: { topUps: counted(now, 300) } }),
  ],
  [
    "Top-up and trades both due: the top-up goes in first, trades wait a day",
    (now) => ({ pcts: DRIFTED, card: { topUps: counted(now, 300) } }),
  ],
  ["Top-up going in: $1,000 into the boards’ mix, all seven", (now) => ({ card: { topUps: counted(now, 1_000) } })],
  ["Ends soon", (now) => ({ card: { endsAt: now + 4 * DAY } })],
  ["Retrying: 3 runs didn’t go through, trades due", () => ({ pcts: DRIFTED, card: { fails: 3 } })],
  ["Retrying: backed off past the next window", (now) => ({ card: { fails: 5, cooldownUntil: now + 2 * DAY } })],
  ["Paused: the credit is in Act, trades due", () => ({ pcts: DRIFTED, debtUsd: 1_300 })],
  ["Paused: the credit is in Act, a top-up waits", (now) => ({ debtUsd: 1_300, card: { topUps: counted(now, 300) } })],
  ["Needs you: the registration is still to go", () => ({ card: { status: "starting", waiting: true } })],
  ["Stopped on its own", (now) => ({ pcts: DRIFTED, card: { status: "off", stoppedAt: now - 2 * DAY } })],
  ["Off, with a mix saved", () => ({ card: { status: "off" } })],
  ["Off, first visit: no mix yet, the stocks held now", () => ({ mixBps: null, card: { status: "off" } })],
  ["Off, nothing held and no mix", () => ({ pcts: [0, 0, 0, 0, 0, 0, 0], mixBps: null, card: { status: "off" } })],
  ["On, no mix saved", () => ({ mixBps: null })],
  ["Coming soon: the agents aren’t live", () => ({ mixBps: null, card: { live: false, status: "unconfigured" } })],
  ["Loading", () => "loading"],
];

export function RebalanceCards() {
  const nowSec = useNowSec();
  const params = useSearchParams();
  if (!nowSec) return null;
  const real = params.has("as");
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[390px] flex-col gap-3 bg-ground px-4 pb-10 pt-[calc(env(safe-area-inset-top)+16px)]">
      <h1 className="m-0 px-1 text-[28px] font-semibold tracking-[-0.03em]">Rebalance card</h1>
      {real && (
        <section className="flex flex-col gap-2">
          <span className="label px-1">This account, live</span>
          <RequireAccount>{(account) => <RebalanceCard account={account} onOpen={OPEN} />}</RequireAccount>
        </section>
      )}
      {STATES.map(([title, fixture]) => {
        const f = fixture(nowSec);
        return (
          <section key={title} className="flex flex-col gap-2">
            <span className="label px-1">{title}</span>
            <RebalanceCardView model={f === "loading" ? null : model(nowSec, f)} onOpen={OPEN} />
          </section>
        );
      })}
    </div>
  );
}

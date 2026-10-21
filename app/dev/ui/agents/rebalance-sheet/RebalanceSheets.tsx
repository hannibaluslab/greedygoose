"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { RebalancePill } from "@/components/gg/agents/RebalanceCard";
import { RebalanceSheet, RebalanceSheetBody } from "@/components/gg/agents/RebalanceSheet";
import { RebalanceSettingsView, type SettingsHolding } from "@/components/gg/agents/RebalanceSettings";
import { CloseIcon } from "@/components/gg/kit/icons";
import { SheetShell } from "@/components/gg/kit/SheetShell";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { useNowSec } from "@/hooks/useNowSec";
import { rebalanceOptions, type MixRow } from "@/lib/agents/mix";
import { nyDay, rebalanceOutlook } from "@/lib/agents/next";
import { rebalanceCard, type RebalanceCardInput } from "@/lib/agents/rebalanceCard";
import type { RebalanceTerms } from "@/lib/agents/rebalanceSettings";
import type { TopUpsChoice, TopUpsFacts, TopUpsSetting } from "@/lib/agents/topUps";
import { MEASURED_MIX, measuredAccount } from "../measuredAccount";

/*
 * Dev only: Rebalance's sheet in every state, with fixtures run through the app's own rules and words
 * (rebalanceOutlook, rebalanceCard, sheetLine, topUpsView, rebalanceSave). Nothing here reads the chain or signs.
 *   /dev/ui/agents/rebalance-sheet                 every state, side by side with boards 7e–7h
 *   ?open=<state>                                  that state as the real sheet, over the Agents page
 *   ?as=0x…                                        the real sheet for that account (read only)
 */

const NOTHING_SIGNED = () => toast("Dev gallery: nothing is signed");

/** Aave's prices, by reserve id: Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla. */
const PRICES = [250, 220, 180, 700, 500, 180, 400];
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const CAP_MAX = usdc(1_000_000);
/** The boards' mix: Apple 20, Amazon 10, Alphabet 10, Meta 10, Microsoft 15, NVIDIA 25, Tesla 10. */
const MIX = [2_000, 1_000, 1_000, 1_000, 1_500, 2_500, 1_000];
/** Board 7a: all inside their bands, NVIDIA a little high (26%), Tesla a little low (9%). */
const ON_TARGET = [20, 10, 10, 10, 15, 26, 9];
/** NVIDIA out of the top of its band (32%), Apple (16%) and Meta (8%) at the bottom of theirs. */
const DRIFTED = [16, 10, 10, 8, 15, 32, 9];
const DAY = 86_400;

/** $10,000 of free stock, `pcts` of it in each stock by reserve id. */
const holdings = (pcts: readonly number[]): SettingsHolding[] =>
  PRICES.map((p, reserveId) => ({
    reserveId,
    priceRaw: BigInt(Math.round(p * 1e8)),
    freeRaw: BigInt(Math.round(((pcts[reserveId] / 100) * 10_000 * 1e8) / p)),
    backingUsd: 0,
  }));

const OFF: TopUpsSetting = { on: false, keepUsd: 500 };
const ON: TopUpsSetting = { on: true, keepUsd: 500 };

type Fixture = {
  title: string;
  /** Free stock by reserve id, % of $10,000. */
  pcts?: readonly number[];
  /** Adrian's measured account and mix, its dollars times this (measuredAccount), instead of `pcts` and the boards'. */
  measured?: number;
  /** A mix of its own, BPS by reserve id, instead of the boards' (or Adrian's with `measured`). */
  mix?: readonly number[];
  /** What's owed against $2,000 of backing at a 70% factor: $600 is Safe, $1,300 is in Act. */
  debtUsd?: number;
  live?: boolean;
  /** Rebalance's own state: on unless said. */
  card?: Partial<RebalanceCardInput>;
  terms?: RebalanceTerms;
  saved?: readonly number[];
  draft?: MixRow[];
  topUps?: Partial<TopUpsFacts>;
  draftTopUps?: TopUpsChoice;
  /** Earning (the Save job) is off: turning top-ups on grants it in the same Face ID. */
  earningOff?: boolean;
  finish?: boolean;
  /** Dollars of top-ups counted yesterday, going in at the next check (Keep $500, enough savings above it). */
  invest?: number;
};

export const STATES: Record<string, Fixture> = {
  "top-ups-off": { title: "7e · Top-ups off, nothing changed", topUps: { saved: OFF } },
  "turn-on": {
    title: "7f · Turning top-ups on: a new grant, one Face ID",
    topUps: { saved: OFF },
    draftTopUps: { on: true, keepUsd: 500 },
  },
  "turn-on-earning-off": {
    title: "Turning top-ups on while earning is off: earning in the same Face ID",
    topUps: { saved: OFF },
    draftTopUps: { on: true, keepUsd: 500 },
    earningOff: true,
  },
  waiting: {
    title: "7g · $300 waiting for the next check",
    topUps: { saved: ON, waiting: { usd: 300, atSec: 0 } },
  },
  "going-in": {
    title: "$1,000 of top-ups going in at the next check: the line says it",
    topUps: { saved: ON, waiting: { usd: 1_000, atSec: 0 } },
    invest: 1_000,
  },
  "going-in-trades-due": {
    title: "A top-up and trades both due: the top-up first, trades wait a day",
    pcts: DRIFTED,
    topUps: { saved: ON, waiting: { usd: 300, atSec: 0 } },
    invest: 300,
  },
  "waiting-regrant": {
    title: "$300 waiting and a Save that grants again: it stays as cash",
    // A capped grant from before is granted again at CAP_MAX, which drops what was counted.
    terms: { capRaw: usdc(100), limitsRaw: MIX.map(() => 1n), topUps: true },
    topUps: { saved: ON, waiting: { usd: 300, atSec: 0 } },
  },
  "waiting-turn-off": {
    title: "$300 waiting and top-ups turned off: it stays as cash",
    topUps: { saved: ON, waiting: { usd: 300, atSec: 0 } },
    draftTopUps: { on: false, keepUsd: 500 },
  },
  warning: {
    title: "7h · Keep $0, owing, Protector can’t sell: the warning",
    topUps: { saved: ON, protectSells: false },
    draftTopUps: { on: true, keepUsd: 0 },
  },
  "warning-turn-on": {
    title: "Turning on with Keep $0 while owing: the warning comes first",
    topUps: { saved: OFF, protectSells: false },
    draftTopUps: { on: true, keepUsd: 0 },
  },
  "on-unchanged": { title: "On, nothing changed: no Save", topUps: { saved: ON } },
  "keep-only": {
    title: "Only Keep changed: Save, no new grant",
    topUps: { saved: ON },
    draftTopUps: { on: true, keepUsd: 1_000 },
  },
  "keep-zero": {
    title: "Keep $0, nothing owed: no warning",
    debtUsd: 0,
    topUps: { saved: ON, protectSells: false },
    draftTopUps: { on: true, keepUsd: 0 },
  },
  "keep-empty": {
    title: "Keep emptied: Save waits for an amount",
    topUps: { saved: ON },
    draftTopUps: { on: true, keepUsd: null },
  },
  unread: {
    title: "A grant with top-ups, the switch not read yet: a new grant waits",
    // A capped grant from before is granted again at CAP_MAX; the switch's read hasn't come back.
    terms: { capRaw: usdc(100), limitsRaw: MIX.map(() => 1n), topUps: true },
    topUps: { saved: null },
  },
  "turn-off": {
    title: "Turning top-ups off: a new grant without the withdraw",
    topUps: { saved: ON },
    draftTopUps: { on: false, keepUsd: 500 },
  },
  "not-available": { title: "Not available yet (until the executor counts top-ups)", topUps: { available: false } },
  "earning-first": {
    title: "Earning off and no one signature: turn on earning first",
    topUps: { saved: OFF, earningFirst: true },
  },
  "new-mix": {
    title: "A new mix: Save",
    topUps: { saved: OFF },
    draft: [
      { reserveId: 0, bps: 3_000 },
      { reserveId: 1, bps: 1_000 },
      { reserveId: 2, bps: 1_000 },
      { reserveId: 3, bps: 1_000 },
      { reserveId: 4, bps: 1_000 },
      { reserveId: 5, bps: 2_000 },
      { reserveId: 6, bps: 1_000 },
    ],
  },
  "not-whole": {
    title: "Mix not at 100% yet",
    topUps: { saved: OFF },
    draft: [
      { reserveId: 0, bps: 2_000 },
      { reserveId: 5, bps: 2_500 },
    ],
  },
  "trades-due": { title: "Trades due at the next check", pcts: DRIFTED, topUps: { saved: OFF } },
  held: { title: "Held by credit: the stock that would trade backs it", measured: 1_000, topUps: { saved: OFF } },
  "too-small": { title: "Too small to trade: Adrian’s $7.74 (2026-10-21)", measured: 1, topUps: { saved: OFF } },
  "agents-page": {
    title: "The Agents page gallery’s mix: NVIDIA 50, Apple 25, Tesla 25, on target",
    pcts: [25, 0, 0, 0, 0, 50, 25],
    mix: [2_500, 0, 0, 0, 0, 5_000, 2_500],
    topUps: { saved: OFF },
  },
  paused: {
    title: "Paused: trades due while the credit is in Act",
    pcts: DRIFTED,
    debtUsd: 1_300,
    topUps: { saved: OFF },
  },
  retrying: { title: "Retrying: the last 3 runs didn’t go through", card: { fails: 3 }, topUps: { saved: OFF } },
  stopped: {
    title: "Stopped on its own: Turn on",
    card: { status: "off", stoppedAt: -2 * DAY },
    terms: null,
    topUps: { saved: OFF },
  },
  "stopped-top-ups-on": {
    title: "Stopped with top-ups still on: Turn on",
    card: { status: "off", stoppedAt: -2 * DAY },
    terms: null,
    topUps: { saved: ON },
  },
  "stopped-top-ups-off": {
    title: "Stopped, switching top-ups off: Save, the setting alone",
    card: { status: "off", stoppedAt: -2 * DAY },
    terms: null,
    topUps: { saved: ON },
    draftTopUps: { on: false, keepUsd: 500 },
  },
  "ends-soon": {
    title: "Ends soon: Renew in the line",
    topUps: { saved: OFF },
    card: { endsAt: 4 * DAY },
  },
  "rebalance-off": {
    title: "Rebalancer off: Turn on",
    card: { status: "off" },
    terms: null,
    topUps: { saved: OFF },
  },
  "needs-you": {
    title: "Needs you: the registration is still to go",
    card: { status: "starting", waiting: true },
    topUps: { saved: OFF },
    finish: true,
  },
  "coming-soon": {
    title: "Coming soon: the agents aren’t live",
    live: false,
    card: { live: false, status: "unconfigured" },
    topUps: { available: false },
  },
};

/** Each state's sheet body and pill, from its fixture. */
export function stateOf(nowSec: number, f: Fixture) {
  const h = f.measured ? measuredAccount(PRICES, f.measured) : holdings(f.pcts ?? ON_TARGET);
  const mix = f.mix ?? (f.measured ? MEASURED_MIX : MIX);
  const debtUsd = f.debtUsd ?? 600;
  const options = rebalanceOptions();
  const live = f.live ?? true;
  // Times in a fixture are from now: `endsAt` ahead, `stoppedAt` behind (negative).
  const card = {
    ...f.card,
    endsAt: f.card?.endsAt ? nowSec + f.card.endsAt : nowSec + 200 * DAY,
    stoppedAt: f.card?.stoppedAt ? nowSec + f.card.stoppedAt : null,
  };
  const outlook = rebalanceOutlook({
    nowSec,
    holdings: h,
    mixBps: mix,
    capMaxRaw: CAP_MAX,
    rebalanceDay: 0,
    debtUsd,
    totalBackingUsd: 2_000,
    avgCf: 0.7,
    left: { rebalance: null },
    capRaw: { rebalance: CAP_MAX },
    numbers: { rebalance: options },
  });
  const model = rebalanceCard({
    live: true,
    nowSec,
    status: "on",
    waiting: false,
    fails: 0,
    cooldownUntil: 0,
    rebalanceDay: 0,
    holdings: h,
    mixBps: mix,
    options,
    outlook,
    topUps: f.invest
      ? {
          state: {
            day: nyDay(nowSec) - 1,
            keepRaw: usdc(500),
            readyRaw: usdc(f.invest),
            todayRaw: 0n,
            markRaw: usdc(f.invest + 1_000),
            ownRaw: 0n,
          },
          savingsRaw: usdc(f.invest + 1_000),
          usdcLeftRaw: CAP_MAX,
          savingsLeftRaw: CAP_MAX,
        }
      : null,
    ...card,
  });
  const status = card.status ?? "on";
  const running = status === "on" || status === "starting";
  const saved = f.topUps?.saved ?? null;
  const terms: RebalanceTerms =
    f.terms === undefined ? { capRaw: CAP_MAX, limitsRaw: mix.map(() => 1n), topUps: !!saved?.on } : f.terms;
  const topUps: TopUpsFacts = {
    available: true,
    earningFirst: false,
    saved,
    waiting: null,
    rate: "4.2%",
    debtUsd,
    protectSells: true,
    nowSec,
    ...f.topUps,
  };
  // The waiting top-up goes in at the next check the outlook names.
  if (topUps.waiting) topUps.waiting = { ...topUps.waiting, atSec: outlook.checkAt };
  const body = (
    <RebalanceSheetBody
      model={model}
      live={live}
      on={running}
      busy={false}
      error={null}
      onAction={NOTHING_SIGNED}
      finish={f.finish ? { onFinish: NOTHING_SIGNED, busy: false, waiting: false, error: null } : undefined}
      settings={
        <RebalanceSettingsView
          holdings={h}
          saved={f.saved ?? mix}
          terms={terms}
          capMaxRaw={live ? CAP_MAX : null}
          configured={live}
          connected
          running={running}
          earningOff={f.earningOff}
          topUps={topUps}
          feeBlocked={false}
          feeLoading={false}
          busy={false}
          phase="idle"
          error={null}
          onSave={NOTHING_SIGNED}
          draft={f.draft}
          draftTopUps={f.draftTopUps}
        />
      }
    />
  );
  return { model, body };
}

/** The sheet as drawn on the boards, inline: its grabber, title, pill and close, then the body. */
function Frame({ pill, children }: { pill: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-t-[28px] bg-sheet shadow-sheet">
      <div aria-hidden className="mx-auto mt-2.5 h-[5px] w-10 rounded-[3px] bg-line-strong" />
      <div className="flex items-start gap-1.5 px-5 pb-3 pt-4">
        <div className="flex min-h-8 min-w-0 flex-1 items-center gap-2">
          <h2 className="m-0 text-[20px] font-semibold tracking-tight-2">Rebalancer</h2>
          {pill}
        </div>
        <span aria-hidden className="ml-1 grid size-8 place-items-center rounded-full bg-[rgba(15,14,11,0.06)]">
          <CloseIcon />
        </span>
      </div>
      <div className="px-5 pb-[34px]">{children}</div>
    </div>
  );
}

export function RebalanceSheets() {
  const nowSec = useNowSec();
  const params = useSearchParams();
  const router = useRouter();
  if (!nowSec) return null;
  const openKey = params.get("open");
  const open = openKey && STATES[openKey] ? stateOf(nowSec, STATES[openKey]) : null;
  const close = () => router.replace("/dev/ui/agents/rebalance-sheet");

  if (params.has("as"))
    return (
      <AgentsPage>
        <RequireAccount>
          {(account) => (
            <RebalanceSheet
              account={account}
              open
              onClose={close}
              busy={false}
              error={null}
              onAction={NOTHING_SIGNED}
            />
          )}
        </RequireAccount>
      </AgentsPage>
    );

  if (open)
    return (
      <AgentsPage>
        <SheetShell
          open
          onOpenChange={(next) => !next && close()}
          title="Rebalancer"
          titleAccessory={<RebalancePill model={open.model} />}
        >
          {open.body}
        </SheetShell>
      </AgentsPage>
    );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[390px] flex-col gap-6 bg-ground px-4 pb-10 pt-[calc(env(safe-area-inset-top)+16px)]">
      <h1 className="m-0 px-1 text-[28px] font-semibold tracking-[-0.03em]">Rebalancer sheet</h1>
      {Object.entries(STATES).map(([key, f]) => {
        const s = stateOf(nowSec, f);
        return (
          <section key={key} data-state={key} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <span className="label">{f.title}</span>
              <Link href={`?open=${key}`} className="shrink-0 text-xs font-semibold text-ink underline">
                Open
              </Link>
            </div>
            <Frame pill={<RebalancePill model={s.model} />}>{s.body}</Frame>
          </section>
        );
      })}
    </div>
  );
}

/** What the sheet slides over: the Agents page's title, as on the boards. */
function AgentsPage({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-[390px] bg-ground px-4 pt-[54px]">
      <h1 className="m-0 ml-1 text-[28px] font-semibold tracking-[-0.03em]">Agents</h1>
      {children}
    </div>
  );
}

import { describe, expect, it } from "vitest";
import { rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import {
  agentNexts,
  BACKING_RULE,
  defaultNumbers,
  rebalanceCheckAt,
  rebalanceOutlook,
  TOO_SMALL,
  whenText,
  type NextInput,
  type OutlookInput,
} from "@/lib/agents/next";
import { rebalanceCard, type RebalanceCardInput, type RebalanceCardModel } from "@/lib/agents/rebalanceCard";
import { sheetLine } from "@/lib/agents/rebalanceSettings";
import { bandBreaks, rebalanceTrades } from "@/lib/agents/rules/rebalance";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";

/*
 * The honest card (Adrian, 2026-10-21, "the Rebalancer is not working, the 5 PM never came"): "On target" only while
 * the whole portfolio, the stock backing credit too, sits inside its band; past it with nothing to trade, the card says
 * what holds it, and its slots show the whole portfolio against the mix, tinted over and under.
 */

const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const CAP_MAX = usdc(1_000_000);
/** Wednesday 2025-10-15 12:00 New York (16:00 UTC, daylight time): today's window has passed. */
const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;
const DAY = 86_400;
const options = rebalanceOptions();

/** Aave's prices, by reserve id: Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla. */
const PRICES = [250, 220, 180, 700, 500, 180, 400];
const raw = (usd: number, price: number) => BigInt(Math.round((usd * 1e8) / price));

/** Each stock's dollars in all, and the free part of them (the rest backs credit), by reserve id. */
function account(wholeUsd: readonly number[], freeUsd: readonly number[]): MixHolding[] {
  return PRICES.map((p, reserveId) => ({
    reserveId,
    priceRaw: BigInt(p * 1e8),
    freeRaw: raw(freeUsd[reserveId], p),
    backingRaw: raw(wholeUsd[reserveId] - freeUsd[reserveId], p),
  }));
}

/**
 * Adrian's account as measured on 2026-10-21 (jawegg.justan.id): $7.74 of stock, Apple 18, Amazon 22, Alphabet 13,
 * Meta 18.5, Microsoft 9, NVIDIA 8, Tesla 11 (%); all of it backs credit but $0.32 of Meta, free in the wallet. `scale`
 * multiplies every dollar.
 */
const SHARES = [18, 22, 13, 18.5, 9, 8, 11];
const adrian = (scale = 1, freeUsd: readonly number[] = [0, 0, 0, 0.32, 0, 0, 0]) =>
  account(
    SHARES.map((pct) => (pct / 100) * 7.74 * scale),
    freeUsd.map((x) => x * scale),
  );
/** His saved mix: Apple 3, Amazon 25, Alphabet 14, Microsoft 58 (%). */
const HIS_MIX = [300, 2_500, 1_400, 0, 5_800, 0, 0];

function outlookIn(holdings: MixHolding[], over: Partial<OutlookInput> = {}): OutlookInput {
  return {
    nowSec: WED_NOON,
    holdings,
    mixBps: HIS_MIX,
    capMaxRaw: CAP_MAX,
    rebalanceDay: 0,
    debtUsd: 3,
    totalBackingUsd: 7.42,
    avgCf: 0.7,
    left: { rebalance: null },
    capRaw: { rebalance: CAP_MAX },
    numbers: { rebalance: options },
    ...over,
  };
}

function card(
  holdings: MixHolding[],
  over: Partial<RebalanceCardInput> = {},
  at: Partial<OutlookInput> = {},
): RebalanceCardModel {
  const o = outlookIn(holdings, at);
  return rebalanceCard({
    live: true,
    nowSec: WED_NOON,
    status: "on",
    waiting: false,
    stoppedAt: null,
    endsAt: WED_NOON + 200 * DAY,
    fails: 0,
    cooldownUntil: 0,
    rebalanceDay: 0,
    holdings: o.holdings,
    mixBps: o.mixBps,
    options,
    outlook: rebalanceOutlook(o),
    ...over,
  })!;
}

const outs = (m: RebalanceCardModel) => m.slots.map((s) => [s.reserveId, s.out]);
const next = whenText(rebalanceCheckAt(WED_NOON, 0), WED_NOON);

describe("bandBreaks: the rule's own band, past its top or its bottom", () => {
  const two = (a: number, b: number) =>
    bandBreaks(
      [
        { sharesRaw: raw(a, 100), price: 100n * 10n ** 8n, weightBps: 5_000n },
        { sharesRaw: raw(b, 100), price: 100n * 10n ** 8n, weightBps: 5_000n },
      ],
      options,
    );

  it("50/50 has 5 points each way: 55/45 sits on the edge, a cent more breaks it", () => {
    expect(two(55, 45)).toEqual([null, null]);
    expect(two(55.01, 44.99)).toEqual(["over", "under"]);
    expect(two(44, 56)).toEqual(["under", "over"]);
  });

  it("agrees with the trades: the rule trades exactly when a stock breaks its band", () => {
    for (const pcts of [
      [20, 10, 10, 10, 15, 26, 9],
      [16, 10, 10, 8, 15, 32, 9],
      [0, 0, 0, 0, 0, 70, 30],
    ]) {
      const stocks = PRICES.map((p, i) => ({
        sharesRaw: raw(pcts[i] * 100, p),
        price: BigInt(p * 1e8),
        weightBps: BigInt([2_000, 1_000, 1_000, 1_000, 1_500, 2_500, 1_000][i]),
        sellLeftRaw: 10n ** 20n,
      }));
      const broken = bandBreaks(stocks, options).some((b) => b !== null);
      expect(rebalanceTrades({ stocks, usdcLeftRaw: CAP_MAX }, options).length > 0).toBe(broken);
    }
  });

  it("leaves out stocks not in the mix, and a mix that holds nothing", () => {
    const none = bandBreaks(
      PRICES.map((p) => ({ sharesRaw: 0n, price: BigInt(p * 1e8), weightBps: 5_000n })),
      options,
    );
    expect(none.every((b) => b === null)).toBe(true);
  });
});

describe("rebalanceOutlook: the whole portfolio, and whether credit is what holds it", () => {
  it("Adrian's account: nothing free in the mix, the whole portfolio far off, every trade under $20 even if freed", () => {
    const o = rebalanceOutlook(outlookIn(adrian()));
    expect(o).toMatchObject({ noMix: false, trades: [], offTarget: true, heldByCredit: false });
  });

  it("the same account at 1,000 times the size: freeing the stock would let it trade, so credit holds it", () => {
    const o = rebalanceOutlook(outlookIn(adrian(1_000), { debtUsd: 3_000, totalBackingUsd: 7_420 }));
    expect(o).toMatchObject({ trades: [], offTarget: true, heldByCredit: true });
  });

  it("trades on free stock come first: not held, whatever backs credit", () => {
    // $1,000 of Apple free: 100% of the free mix against 3%, so it sells Apple and buys the rest.
    const o = rebalanceOutlook(outlookIn(adrian(1_000, [1_000, 0, 0, 320, 0, 0, 0])));
    expect(o.trades.length).toBeGreaterThan(0);
    expect(o).toMatchObject({ offTarget: true, heldByCredit: false });
  });

  it("on target when the whole portfolio is in its band, even if the little free stock isn't", () => {
    // The mix's own shares in all, backing credit, with $15 of Microsoft free: too small to trade, and the whole is in.
    const whole = [3, 25, 14, 0, 58, 0, 0].map((pct) => pct * 100);
    const o = rebalanceOutlook(outlookIn(account(whole, [0, 0, 0, 0, 15, 0, 0])));
    expect(o).toMatchObject({ trades: [], offTarget: false, heldByCredit: false });
  });
});

describe("rebalanceCard: off target with nothing to trade", () => {
  it("held by credit: On, the rule and what lets it trade, the whole portfolio tinted over and under", () => {
    const m = card(adrian(1_000), {}, { debtUsd: 3_000, totalBackingUsd: 7_420 });
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.faded).toBe(false);
    expect(m.footer).toEqual({ kind: "words", line1: BACKING_RULE, line2: "Repay or free up some to let it trade." });
    expect(BACKING_RULE).toBe("Stock that backs your credit isn’t rebalanced.");
    expect(m.label).toBe(`Rebalancer, on. ${BACKING_RULE} Repay or free up some to let it trade.`);
    expect(sheetLine(m)).toEqual({ text: `${BACKING_RULE} Repay or free up some to let it trade.`, renew: false });
    // Apple 29% of the mix's stock against 3%, Amazon 35% against 25%, Alphabet 21% against 14%: over. Microsoft 15%
    // against 58%: under. Nothing trades, so no side and no BUY or SELL.
    expect(outs(m)).toEqual([
      [0, "over"],
      [1, "over"],
      [2, "over"],
      [4, "under"],
    ]);
    expect(m.slots.every((s) => s.side === null)).toBe(true);
  });

  it("Adrian's own account: too small to trade, said with the smallest trade", () => {
    const m = card(adrian());
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.footer).toEqual({ kind: "words", line1: TOO_SMALL, line2: "Trades start at $20." });
    expect(TOO_SMALL).toBe("Off target, but too small to trade.");
    expect(outs(m).map(([, out]) => out)).toEqual(["over", "over", "over", "under"]);
  });

  it("places each logo by the whole portfolio, not the free stock", () => {
    // Free: only Meta, out of the mix, so the free mix is empty and every logo would sit on its target.
    const m = card(adrian(1_000), {}, { debtUsd: 3_000, totalBackingUsd: 7_420 });
    const apple = m.slots.find((s) => s.reserveId === 0)!;
    const msft = m.slots.find((s) => s.reserveId === 4)!;
    expect(apple.offset).toBeGreaterThan(1);
    expect(msft.offset).toBeLessThan(-1);
  });

  it("on target only while the whole portfolio is in its band", () => {
    const whole = [3, 25, 14, 0, 58, 0, 0].map((pct) => pct * 100);
    const m = card(account(whole, [0, 0, 0, 0, 15, 0, 0]));
    expect(m.footer).toEqual({ kind: "on-target", next: next.charAt(0).toUpperCase() + next.slice(1) });
    expect(m.slots.every((s) => s.out === null)).toBe(true);
  });

  it("trades due on free stock: the trades show, sides from them, no over or under", () => {
    const m = card(adrian(1_000, [1_000, 0, 0, 320, 0, 0, 0]), {}, { debtUsd: 3_000, totalBackingUsd: 7_420 });
    expect(m.footer.kind).toBe("trades");
    expect(m.slots.find((s) => s.reserveId === 0)!.side).toBe("sell");
    expect(m.slots.every((s) => s.out === null)).toBe(true);
  });

  it("ends soon while held: Renew first, then the rule", () => {
    const m = card(adrian(1_000), { endsAt: WED_NOON + 3 * DAY }, { debtUsd: 3_000, totalBackingUsd: 7_420 });
    expect(m.pill.text).toBe("Ends soon");
    expect(m.footer).toMatchObject({ kind: "words", line2: BACKING_RULE });
    expect(sheetLine(m).renew).toBe(true);
  });

  it("keeps the other states: retrying, needs you and stopped come first, faded ones mark nothing", () => {
    const big = adrian(1_000);
    const at = { debtUsd: 3_000, totalBackingUsd: 7_420 };
    expect(card(big, { fails: 3 }, at).pill.text).toBe("Retrying");
    const needs = card(big, { status: "starting" }, at);
    expect(needs.pill.text).toBe("Needs you");
    expect(needs.slots.every((s) => s.out === null)).toBe(true);
    const stopped = card(big, { status: "off", stoppedAt: WED_NOON - DAY }, at);
    expect(stopped.pill.text).toBe("Stopped");
    expect(stopped.slots.every((s) => s.out === null)).toBe(true);
    expect(card(big, { status: "off" }, at).pill.text).toBe("Off");
  });
});

describe("the Agents list's next line says the same", () => {
  const byJob = <T>(f: (job: AgentJob) => T) => Object.fromEntries(JOBS.map((j) => [j, f(j)])) as Record<AgentJob, T>;
  const nextIn = (holdings: MixHolding[], debtUsd: number, backingUsd: number): NextInput => ({
    nowSec: WED_NOON,
    savingsRaw: 0n,
    totalBackingUsd: backingUsd,
    avgCf: 0.7,
    debtUsd,
    holdings,
    mixBps: HIS_MIX,
    left: byJob(() => null),
    capRaw: byJob(() => CAP_MAX),
    capMaxRaw: CAP_MAX,
    numbers: defaultNumbers(options),
    rebalanceDay: 0,
    rescuing: false,
    sellOn: false,
    pricesHeld: false,
    plan: null,
  });

  it("held by credit, or too small, never On target", () => {
    expect(agentNexts(nextIn(adrian(1_000), 3_000, 7_420)).rebalance).toEqual({
      idle: "Stock that backs your credit isn’t rebalanced",
    });
    expect(agentNexts(nextIn(adrian(), 3, 7.42)).rebalance).toEqual({ idle: "Off target, but too small to trade" });
  });
});

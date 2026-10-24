import { describe, expect, it } from "vitest";
import { rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import {
  agentNexts,
  BACKING_RULE,
  blockedWords,
  defaultNumbers,
  nextRound,
  rebalanceOutlook,
  whenText,
  type NextInput,
  type OutlookInput,
} from "@/lib/agents/next";
import { rebalanceCard, type RebalanceCardInput, type RebalanceCardModel } from "@/lib/agents/rebalanceCard";
import { sheetLine } from "@/lib/agents/rebalanceSettings";
import { bandBreaks, rebalanceTrades } from "@/lib/agents/rules/rebalance";
import { NO_LIMIT } from "@/lib/agents/permissions";

/*
 * The honest card (Adrian, 2026-10-21, "the Rebalancer is not working, the 5 PM never came"): "On target" only while
 * the whole portfolio, the stock backing credit too, sits inside its band; past it with nothing to trade, the card says
 * what holds it, and its slots show the whole portfolio against the mix, tinted over and under.
 */

/** Wednesday 2025-10-15 12:00 New York (16:00 UTC, daylight time). */
const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;
const DAY = 86_400;
const options = rebalanceOptions();

/** Aave's prices, by reserve id: Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla. */
const PRICES = [250, 220, 180, 700, 500, 180, 400];
const raw = (usd: number, price: number) => BigInt(Math.round((usd * 1e8) / price));

/** Each stock's dollars in all, and the free part of them (the rest backs credit, never below 0), by reserve id. */
function account(wholeUsd: readonly number[], freeUsd: readonly number[]): MixHolding[] {
  if (freeUsd.some((x, i) => x > wholeUsd[i])) throw new Error("More free than held");
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
    pacing: { sessionAt: 0, mixSetAt: 0 },
    debtUsd: 3,
    totalBackingUsd: 7.42,
    avgCf: 0.7,
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
    refused: 0,
    holdings: o.holdings,
    mixBps: o.mixBps,
    options,
    outlook: rebalanceOutlook(o),
    ...over,
  })!;
}

const outs = (m: RebalanceCardModel) => m.slots.map((s) => [s.reserveId, s.out]);
const next = whenText(nextRound(WED_NOON), WED_NOON);

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
      expect(rebalanceTrades({ stocks, usdcLeftRaw: NO_LIMIT }, options).length > 0).toBe(broken);
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

describe("rebalanceOutlook: the whole portfolio, and what holds the Rebalancer back", () => {
  it("Adrian's account: nothing free in the mix, the whole portfolio far off: credit holds it, however small", () => {
    // No trade is too small any more (the Planner's minTrade is 0): freeing the stock would let it trade.
    const o = rebalanceOutlook(outlookIn(adrian()));
    expect(o).toMatchObject({ noMix: false, trades: [], offTarget: true, blocked: "credit" });
  });

  it("the same account at 1,000 times the size: freeing the stock would let it trade, so credit holds it", () => {
    const o = rebalanceOutlook(outlookIn(adrian(1_000), { debtUsd: 3_000, totalBackingUsd: 7_420 }));
    expect(o).toMatchObject({ trades: [], offTarget: true, blocked: "credit" });
  });

  it("trades on free stock come first: nothing blocks it, whatever backs credit", () => {
    // $1,000 of Apple free: 100% of the free mix against 3%, so it sells Apple and buys the rest.
    const o = rebalanceOutlook(outlookIn(adrian(1_000, [1, 0, 0, 0.32, 0, 0, 0])));
    expect(o.trades.length).toBeGreaterThan(0);
    expect(o).toMatchObject({ offTarget: true, blocked: null });
  });

  it("the whole portfolio in its band: nothing holds it, and the little free stock still trades (no smallest trade)", () => {
    // The mix's own shares in all, backing credit, with $15 of Microsoft free: the whole is in its band, and the free
    // stock alone is all Microsoft, so it trades toward the mix.
    const whole = [3, 25, 14, 0, 58, 0, 0].map((pct) => pct * 100);
    const o = rebalanceOutlook(outlookIn(account(whole, [0, 0, 0, 0, 15, 0, 0])));
    expect(o).toMatchObject({ offTarget: false, blocked: null });
    expect(o.trades.length).toBeGreaterThan(0);
    // With nothing free, it is on target.
    expect(rebalanceOutlook(outlookIn(account(whole, [0, 0, 0, 0, 0, 0, 0])))).toMatchObject({
      trades: [],
      offTarget: false,
      blocked: null,
    });
  });

  it("a small mix of free stock trades: no trade is too small (once $20, Trades start at $20)", () => {
    // $34.20 of free stock, all of it in the mix and none backing credit: Apple 35% against 3%, Microsoft 21% against
    // 58%. Selling $11 of Apple for Microsoft brings it back.
    const free = [12, 10, 5, 0, 7.2, 0, 0];
    const o = rebalanceOutlook(outlookIn(account(free, free)));
    expect(o.trades.length).toBeGreaterThan(0);
    expect(o).toMatchObject({ offTarget: true, blocked: null });
  });

  it("none of the mix held, free or backing: never On target, nothing to keep", () => {
    // Only Meta, out of his mix.
    const o = rebalanceOutlook(outlookIn(account([0, 0, 0, 500, 0, 0, 0], [0, 0, 0, 500, 0, 0, 0])));
    expect(o).toMatchObject({ trades: [], offTarget: false, blocked: "none-held" });
    expect(rebalanceOutlook(outlookIn(account([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0])))).toMatchObject({
      blocked: "none-held",
    });
  });
});

describe("rebalanceCard: off target with nothing to trade", () => {
  it("held by credit: On, the rule and what lets it trade, the whole portfolio tinted over and under", () => {
    const m = card(adrian(1_000), {}, { debtUsd: 3_000, totalBackingUsd: 7_420 });
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.faded).toBe(false);
    // What to send so today's top-ups put the whole portfolio back in its bands (Adrian, 2026-10-22); with top-ups
    // off, sending alone doesn't go in.
    expect(m.footer).toEqual({
      kind: "words",
      line1: "Send $203,408 to fix your mix.",
      line2: "Turn on top-ups so it goes in.",
    });
    expect(BACKING_RULE).toBe("Stock that backs your credit isn’t rebalanced.");
    expect(m.label).toBe("Rebalancer, on. Send $203,408 to fix your mix. Turn on top-ups so it goes in.");
    expect(sheetLine(m)).toEqual({
      text: "Send $203,408 to fix your mix. Turn on top-ups so it goes in.",
      renew: false,
    });
    // Apple 29% of the mix's stock against 3%, Amazon 35% against 25%, Alphabet 21% against 14%: over, and they back
    // credit, so they wear the backs-credit mark, not a sell tint. Microsoft 15% against 58%: under, what's sent buys.
    expect(outs(m)).toEqual([
      [0, null],
      [1, null],
      [2, null],
      [4, "under"],
    ]);
    expect(m.slots.filter((s) => s.backs).map((s) => s.reserveId)).toEqual([0, 1, 2]);
    expect(m.slots.every((s) => s.side === null)).toBe(true);
  });

  it("held by credit with nothing owed, or in Act: the same words, freeing up is what lets it trade", () => {
    const owesNothing = card(adrian(1_000), {}, { debtUsd: 0, totalBackingUsd: 7_420 });
    expect(owesNothing.footer).toEqual({
      kind: "words",
      line1: "Send $203,408 to fix your mix.",
      line2: "Turn on top-ups so it goes in.",
    });
    const inAct = card(adrian(1_000), {}, { debtUsd: 5_000, totalBackingUsd: 7_420 });
    expect(inAct.pill).toEqual({ text: "On", tone: "on" });
    expect(inAct.footer).toEqual({
      kind: "words",
      line1: "Send $203,408 to fix your mix.",
      line2: "Turn on top-ups so it goes in.",
    });
  });

  it("Adrian's own account: all of his mix backs credit, so what to send to fix it", () => {
    const m = card(adrian());
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.footer).toEqual({
      kind: "words",
      line1: "Send $204 to fix your mix.",
      line2: "Turn on top-ups so it goes in.",
    });
    expect(outs(m).map(([, out]) => out)).toEqual([null, null, null, "under"]);
    expect(m.slots.filter((s) => s.backs)).toHaveLength(3);
    expect(sheetLine(m).text).toBe("Send $204 to fix your mix. Turn on top-ups so it goes in.");
  });

  it("a small mix of free stock: the trades are due, never 'too small' (no smallest trade)", () => {
    const free = [12, 10, 5, 0, 7.2, 0, 0];
    const m = card(account(free, free));
    expect(m.footer.kind).toBe("trades");
    expect(JSON.stringify(m)).not.toMatch(/too small|Trades start/);
  });

  it("nothing it can trade at all: says so and when it checks next", () => {
    expect(blockedWords("no-trade", next)).toEqual([
      "Off target, but nothing it can trade now.",
      `Next check ${next}.`,
    ]);
  });

  it("none of the mix held: never On target, says what starts it", () => {
    const meta = [0, 0, 0, 500, 0, 0, 0];
    const m = card(account(meta, meta));
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.footer).toEqual({
      kind: "words",
      line1: "You hold none of your mix yet.",
      line2: "Buy some and it keeps them on target.",
    });
    expect(m.slots.every((s) => s.out === null)).toBe(true);
  });

  it("every block has two lines, and none uses a word the app never shows", () => {
    for (const b of ["credit", "no-trade", "none-held"] as const) {
      const words = blockedWords(b, next);
      expect(words).toHaveLength(2);
      expect(words.join(" ")).not.toMatch(/borrow|loan|\block|locked|collateral|\broom\b|—/i);
    }
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
    const m = card(account(whole, [0, 0, 0, 0, 0, 0, 0]));
    expect(m.footer).toEqual({ kind: "on-target", next: next.charAt(0).toUpperCase() + next.slice(1) });
    expect(m.slots.every((s) => s.out === null)).toBe(true);
  });

  it("trades due on free stock: the trades show, sides from them, no over or under", () => {
    const m = card(adrian(1_000, [1, 0, 0, 0.32, 0, 0, 0]), {}, { debtUsd: 3_000, totalBackingUsd: 7_420 });
    expect(m.footer.kind).toBe("trades");
    expect(m.slots.find((s) => s.reserveId === 0)!.side).toBe("sell");
    expect(m.slots.every((s) => s.out === null)).toBe(true);
  });

  it("trades due: the logos are the free stock the trades move, so a SELL never sits below its line", () => {
    // A 50/50 Apple and Amazon mix. In all, Apple 48 and Amazon 52 (in band); free, Apple 80 and Amazon 20, so the
    // check sells free Apple. Drawn on the whole portfolio, Apple would sit under its line with SELL on it.
    const m = card(
      account([4_800, 5_200, 0, 0, 0, 0, 0], [800, 200, 0, 0, 0, 0, 0]),
      {},
      { mixBps: [5_000, 5_000, 0, 0, 0, 0, 0] },
    );
    expect(m.footer.kind).toBe("trades");
    const apple = m.slots.find((s) => s.reserveId === 0)!;
    expect(apple.side).toBe("sell");
    expect(apple.offset).toBeGreaterThan(0);
    expect(m.slots.find((s) => s.reserveId === 1)!).toMatchObject({ side: "buy" });
    expect(m.slots.find((s) => s.reserveId === 1)!.offset).toBeLessThan(0);
  });

  it("ends soon while held: Renew first, then the rule", () => {
    const m = card(adrian(1_000), { endsAt: WED_NOON + 3 * DAY }, { debtUsd: 3_000, totalBackingUsd: 7_420 });
    expect(m.pill.text).toBe("Ends soon");
    expect(m.footer).toMatchObject({ kind: "words", line2: BACKING_RULE });
    expect(sheetLine(m).renew).toBe(true);
  });

  it("Paused draws the free stock its trades wait to move, and marks nothing past its band", () => {
    // Free: Apple 80, Amazon 20 against 50/50, so trades wait while the credit is in Act. In all, Apple sits under its
    // band and Amazon over it: drawing or tinting that would say the opposite of what the waiting trades do.
    const m = card(
      account([3_000, 7_000, 0, 0, 0, 0, 0], [800, 200, 0, 0, 0, 0, 0]),
      {},
      { mixBps: [5_000, 5_000, 0, 0, 0, 0, 0], debtUsd: 7_000, totalBackingUsd: 9_000 },
    );
    expect(m.pill.text).toBe("Paused");
    expect(m.slots.every((s) => s.out === null && s.side === null)).toBe(true);
    expect(m.slots.find((s) => s.reserveId === 0)!.offset).toBeGreaterThan(0);
    expect(m.slots.find((s) => s.reserveId === 1)!.offset).toBeLessThan(0);
  });

  it("keeps the other states: retrying, needs you and stopped come first, and mark nothing past the band", () => {
    const big = adrian(1_000);
    const at = { debtUsd: 3_000, totalBackingUsd: 7_420 };
    const retrying = card(big, { refused: 3 }, at);
    expect(retrying.pill.text).toBe("Retrying");
    expect(retrying.slots.every((s) => s.out === null)).toBe(true);
    const needs = card(big, { status: "starting" }, at);
    expect(needs.pill.text).toBe("Needs you");
    expect(needs.slots.every((s) => s.out === null)).toBe(true);
    const stopped = card(big, { status: "off", stoppedAt: WED_NOON - DAY }, at);
    expect(stopped.pill.text).toBe("Stopped");
    expect(stopped.slots.every((s) => s.out === null)).toBe(true);
    expect(card(big, { status: "off" }, at).pill.text).toBe("Off");
  });
});

/**
 * jawegg.justan.id on 2026-10-24 after the Guard's first rounds: the free stock, all the Rebalancer trades, sits in its
 * band (Apple 11, Amazon 20, Alphabet 6, Meta 7, Tesla 55 against 10, 18, 7, 8, 57); the $7.17 backing credit holds the
 * whole portfolio far off. Dollars by reserve id, free and backing.
 */
const JAWEGG_FREE = [0.078, 0.142, 0.045, 0.051, 0, 0, 0.393];
const JAWEGG_BACKING = [1.441, 1.617, 0.941, 1.027, 0.678, 0.611, 0.853];
const JAWEGG_MIX = [1_000, 1_800, 700, 800, 0, 0, 5_700];
const jawegg = () =>
  account(
    JAWEGG_FREE.map((x, i) => x + JAWEGG_BACKING[i]),
    JAWEGG_FREE,
  );

describe("rebalanceCard: the free stock on target, the stock backing credit off it (Adrian, 2026-10-24)", () => {
  const done = (over: Partial<RebalanceCardInput> = {}) =>
    card(jawegg(), { topUps: { readyRaw: 0n }, ...over }, { mixBps: JAWEGG_MIX, debtUsd: 4.06, totalBackingUsd: 7.17 });

  it("says the free stock is done and the stock backing credit stays, with no amount to send", () => {
    const o = rebalanceOutlook(outlookIn(jawegg(), { mixBps: JAWEGG_MIX, debtUsd: 4.06, totalBackingUsd: 7.17 }));
    expect(o.blocked).toBe("credit");
    expect(o.freeOnTarget).toBe(true);
    const m = done();
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.footer).toEqual({
      kind: "words",
      line1: "Your free stock is on target.",
      line2: "Stock backing your credit stays as it is.",
    });
    expect(sheetLine(m).text).toBe("Your free stock is on target. Stock backing your credit stays as it is.");
    expect(JSON.stringify(m)).not.toMatch(/Send \$|whole portfolio/);
    expect(JSON.stringify(m)).not.toMatch(/borrow|loan|\block|locked|collateral|—/i);
  });

  it("draws the free stock in its band: no over, no under, no backs-credit mark, no side", () => {
    const m = done();
    expect(m.slots.map((s) => s.reserveId)).toEqual([0, 1, 2, 3, 6]);
    expect(m.slots.every((s) => s.out === null && !s.backs && s.side === null)).toBe(true);
    expect(m.slots.every((s) => Math.abs(s.offset) <= 1)).toBe(true);
  });

  it("with top-ups off, says the same: nothing to send while the free stock is done", () => {
    expect(done({ topUps: null }).footer).toEqual({
      kind: "words",
      line1: "Your free stock is on target.",
      line2: "Stock backing your credit stays as it is.",
    });
  });

  it("free stock off its own band: the card stays as it was, the whole portfolio and what to send", () => {
    // The same account, with Tesla's free part sold: the free stock breaks its band, so it isn't done.
    const off = account(
      JAWEGG_FREE.map((x, i) => x + JAWEGG_BACKING[i] - (i === 6 ? 0.393 : 0)),
      JAWEGG_FREE.map((x, i) => (i === 6 ? 0 : x)),
    );
    const o = rebalanceOutlook(outlookIn(off, { mixBps: JAWEGG_MIX }));
    expect(o.freeOnTarget).toBe(false);
  });
});

describe("the Agents list's next line says the same", () => {
  const nextIn = (holdings: MixHolding[], debtUsd: number, backingUsd: number): NextInput => ({
    nowSec: WED_NOON,
    savingsRaw: 0n,
    totalBackingUsd: backingUsd,
    avgCf: 0.7,
    debtUsd,
    holdings,
    mixBps: HIS_MIX,
    numbers: defaultNumbers(options),
    pacing: { sessionAt: 0, mixSetAt: 0 },
    rescuing: false,
    sellOn: false,
    plan: null,
  });

  it("held by credit, at any size, or none of the mix held, never On target", () => {
    expect(agentNexts(nextIn(adrian(1_000), 3_000, 7_420)).rebalance).toEqual({
      idle: "Stock that backs your credit isn’t rebalanced",
    });
    expect(agentNexts(nextIn(adrian(), 3, 7.42)).rebalance).toEqual({
      idle: "Stock that backs your credit isn’t rebalanced",
    });
    const meta = [0, 0, 0, 500, 0, 0, 0];
    expect(agentNexts(nextIn(account(meta, meta), 0, 0)).rebalance).toEqual({ idle: "You hold none of your mix yet" });
  });

  it("held by credit with the free stock on target: says the free stock is done", () => {
    const idle = agentNexts({ ...nextIn(jawegg(), 4.06, 7.17), mixBps: JAWEGG_MIX }).rebalance;
    expect(idle).toEqual({ idle: `Free stock on target. Checks ${whenText(nextRound(WED_NOON), WED_NOON)}` });
  });
});

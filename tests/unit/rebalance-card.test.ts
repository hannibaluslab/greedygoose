import { describe, expect, it } from "vitest";
import { mixBpsNow, rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import { nextRound, REBALANCE_GAP_SEC, rebalanceOutlook, whenText, type OutlookInput } from "@/lib/agents/next";
import {
  investDue,
  mixScale,
  mixSlots,
  OFFSET_MAX,
  rebalanceCard,
  type CardTopUps,
  type RebalanceCardInput,
} from "@/lib/agents/rebalanceCard";
import { sheetLine } from "@/lib/agents/rebalanceSettings";
import { bandOf } from "@/lib/agents/rules/rebalance";

const usdc = (x: number) => BigInt(Math.round(x * 1e6));
/** Wednesday 2025-10-15 12:00 New York (16:00 UTC, daylight time). */
const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;
const DAY = 86_400;
/** A date as the card writes it, in the viewer's own time zone ("Oct 19" in New York is "Oct 20" in Tokyo). */
const dateOf = (sec: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(sec * 1000);

/** Aave's prices, by reserve id: Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla. */
const PRICES = [250, 220, 180, 700, 500, 180, 400];
/** $10,000 of free stock, `pcts` of it in each stock by reserve id. */
const holdings = (pcts: readonly number[]): MixHolding[] =>
  PRICES.map((p, reserveId) => ({
    reserveId,
    priceRaw: BigInt(Math.round(p * 1e8)),
    freeRaw: BigInt(Math.round(((pcts[reserveId] / 100) * 10_000 * 1e8) / p)),
  }));

/** The boards' mix, and where the stocks sit on board 7a (on target) and on "Coin hop" (trades due). */
const MIX = [2_000, 1_000, 1_000, 1_000, 1_500, 2_500, 1_000];
const ON_TARGET = [20, 10, 10, 10, 15, 26, 9];
const DRIFTED = [16, 10, 10, 8, 15, 32, 9];
const options = rebalanceOptions();

function outlookIn(over: Partial<OutlookInput> = {}): OutlookInput {
  return {
    nowSec: WED_NOON,
    holdings: holdings(ON_TARGET),
    mixBps: MIX,
    pacing: { sessionAt: 0, mixSetAt: 0 },
    debtUsd: 600,
    totalBackingUsd: 2_000,
    avgCf: 0.7,
    numbers: { rebalance: options },
    ...over,
  };
}

/** Rebalance on, board 7a's mix on target, Safe, its grant far from its end. */
function input(over: Partial<RebalanceCardInput> = {}, at: Partial<OutlookInput> = {}): RebalanceCardInput {
  const o = outlookIn(at);
  return {
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
  };
}
const card = (over?: Partial<RebalanceCardInput>, at?: Partial<OutlookInput>) => rebalanceCard(input(over, at))!;
const next = whenText(nextRound(WED_NOON), WED_NOON); // the next round, "today 12:10 PM" in the viewer's own time

describe("mixSlots: each mix stock placed by its drift, in its own band", () => {
  it("places NVIDIA 26% of 25% at +0.2 of its band and Tesla 9% of 10% at −0.5, as board 7a draws them", () => {
    const slots = mixSlots({ holdings: holdings(ON_TARGET), mixBps: MIX, options, trades: [] });
    expect(slots.map((s) => s.reserveId)).toEqual([0, 1, 2, 3, 4, 5, 6]); // Home's order
    expect(slots.map((s) => s.targetBps)).toEqual(MIX);
    expect(slots[5].offset).toBeCloseTo(0.2, 3);
    expect(slots[6].offset).toBeCloseTo(-0.5, 3);
    expect(slots[0].offset).toBeCloseTo(0, 3);
    expect(slots.every((s) => s.side === null)).toBe(true);
  });

  it("measures the band as the rule does: the smaller of 20% of the target and 5 points", () => {
    expect(bandOf(2_500n, options)).toBe(500n);
    expect(bandOf(1_000n, options)).toBe(200n);
    expect(bandOf(5_000n, options)).toBe(500n); // 20% would be 10 points
  });

  it("clamps a stock far past its band, and one with nothing held, so its logo stays in its slot", () => {
    const slots = mixSlots({ holdings: holdings([16, 10, 10, 0, 15, 40, 9]), mixBps: MIX, options, trades: [] });
    expect(slots[5].offset).toBe(OFFSET_MAX); // NVIDIA 40% of 25%: three bands over
    expect(slots[3].offset).toBe(-OFFSET_MAX); // Meta: none held
    expect(slots[0].offset).toBeCloseTo(-1, 3); // Apple 16% of 20%: its band's edge
  });

  it("takes each side from the trades, never the drift: Meta is bought though it sits inside its band", () => {
    const o = rebalanceOutlook(outlookIn({ holdings: holdings(DRIFTED) }));
    const slots = mixSlots({ holdings: holdings(DRIFTED), mixBps: MIX, options, trades: o.trades });
    const sides = Object.fromEntries(slots.map((s) => [s.reserveId, s.side]));
    expect(sides).toEqual({ 0: "buy", 1: null, 2: null, 3: "buy", 4: null, 5: "sell", 6: null });
    expect(slots[3].offset).toBeCloseTo(-1, 3); // 8% of 10%: at its band's edge, not past it
  });

  it("draws only the mix's stocks: a two-stock mix has two slots", () => {
    const slots = mixSlots({
      holdings: holdings([0, 0, 0, 0, 0, 70, 30]),
      mixBps: [0, 0, 0, 0, 0, 6_000, 4_000],
      options,
      trades: [],
    });
    expect(slots.map((s) => [s.reserveId, s.targetBps])).toEqual([
      [5, 6_000],
      [6, 4_000],
    ]);
    expect(slots[0].offset).toBe(OFFSET_MAX); // 70% of 60%: two bands over
  });

  it("before a mix is saved, draws the stocks held now at their share now, on target; with nothing held, the seven", () => {
    const held = mixSlots({ holdings: holdings([0, 0, 0, 0, 0, 75, 25]), mixBps: null, options, trades: [] });
    expect(held).toEqual([
      { reserveId: 5, targetBps: 7_500, offset: 0, side: null, out: null },
      { reserveId: 6, targetBps: 2_500, offset: 0, side: null, out: null },
    ]);
    const none = mixSlots({
      holdings: holdings([0, 0, 0, 0, 0, 0, 0]),
      mixBps: [0, 0, 0, 0, 0, 0, 0],
      options,
      trades: [],
    });
    expect(none.map((s) => s.targetBps)).toEqual([null, null, null, null, null, null, null]);
  });

  it("reads each share in exact BPS, among the mix's stocks only", () => {
    const now = mixBpsNow(holdings([20, 10, 10, 10, 15, 26, 9]), [0, 0, 0, 0, 0, 5_000, 5_000])!;
    expect(now[5]).toBeCloseTo((26 / 35) * 10_000, 1);
    expect(now[6]).toBeCloseTo((9 / 35) * 10_000, 1);
    expect(now[0]).toBe(0);
    expect(mixBpsNow(holdings([0, 0, 0, 0, 0, 0, 0]), MIX)).toBeNull();
  });
});

describe("rebalanceOutlook: the sheet's line and the card share it", () => {
  it("finds the trades, when it looks next, and whether it waits in Act", () => {
    expect(rebalanceOutlook(outlookIn())).toEqual({
      noMix: false,
      trades: [],
      checkAt: nextRound(WED_NOON),
      inAct: false,
      topUpsHeld: false,
      topUpsFrom: 1.1,
      waitsInAct: false,
      offTarget: false,
      blocked: null,
      freeOnTarget: true,
    });
    expect(rebalanceOutlook(outlookIn({ mixBps: null }))).toMatchObject({
      noMix: true,
      trades: [],
      freeOnTarget: false,
    });
    const drifted = rebalanceOutlook(outlookIn({ holdings: holdings(DRIFTED) }));
    expect(drifted.trades.map((t) => [t.reserveId, t.buy])).toEqual([
      [5, false],
      [0, true],
      [3, true],
    ]);
    // $1,300 owed on $2,000 at 70%: health 1.08, in Act.
    expect(rebalanceOutlook(outlookIn({ holdings: holdings(DRIFTED), debtUsd: 1_300 })).waitsInAct).toBe(true);
    // In Act but nothing to trade: it doesn't wait for anything (a top-up going in would: the card reads `inAct`).
    expect(rebalanceOutlook(outlookIn({ debtUsd: 1_300 }))).toMatchObject({ inAct: true, waitsInAct: false });
  });

  it("holds top-ups under GooseGuard's invest line: 1.10, or Protect's own line when the user set it higher", () => {
    // $1,200 owed on $2,000 at 70%: health 1.17, out of Act.
    const at117 = outlookIn({ debtUsd: 1_200 });
    expect(rebalanceOutlook(at117)).toMatchObject({ inAct: false, topUpsHeld: false, topUpsFrom: 1.1 });
    const raised = rebalanceOutlook({ ...at117, numbers: { ...at117.numbers, triggerHf: 1.2 } });
    expect(raised).toMatchObject({ inAct: false, topUpsHeld: true, topUpsFrom: 1.2 });
  });
});

describe("rebalanceCard: the first state that applies, in board 7's order, with its words", () => {
  it("all good: On, the green On target and the next check", () => {
    const m = card();
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.faded).toBe(false);
    expect(m.footer).toEqual({ kind: "on-target", next: next.charAt(0).toUpperCase() + next.slice(1) });
    expect(m.label).toBe(`Rebalancer, on. On target. Next check ${next}.`);
  });

  it("trades due: the count and when, the traded slots tinted", () => {
    const m = card({}, { holdings: holdings(DRIFTED) });
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.footer).toMatchObject({ kind: "trades", text: "3 trades" });
    expect(m.slots.filter((s) => s.side).map((s) => [s.reserveId, s.side])).toEqual([
      [0, "buy"],
      [3, "buy"],
      [5, "sell"],
    ]);
    expect(m.label).toBe(`Rebalancer, on. 3 trades ${next}. Sells NVIDIA. Buys Apple and Meta.`);
    // One by one, as GooseGuard makes them: the sale first, and the buys spend what it brings at least.
    expect(m.moves.map((x) => [x.reserveId, x.side])).toEqual([
      [5, "sell"],
      [0, "buy"],
      [3, "buy"],
    ]);
    const [sale, ...buys] = m.moves;
    expect(buys.reduce((a, x) => a + x.usd, 0)).toBeCloseTo(sale.usd, 5);
  });

  it("ends soon: within a week of its grant's end, on target", () => {
    const m = card({ endsAt: WED_NOON + 4 * DAY });
    expect(m.pill).toEqual({ text: "Ends soon", tone: "due" });
    expect(m.footer).toEqual({
      kind: "words",
      line1: `Ends on ${dateOf(WED_NOON + 4 * DAY)}. Then nothing trades.`,
      line2: `On target. Checks ${next}.`,
    });
  });

  it("paused: trades due while the credit is in Act; the picture keeps no trade", () => {
    const m = card({}, { holdings: holdings(DRIFTED), debtUsd: 1_300 });
    expect(m.pill).toEqual({ text: "Paused", tone: "neutral" });
    expect(m.faded).toBe(false);
    expect(m.footer).toEqual({
      kind: "words",
      line1: "Waits until your credit is out of Act.",
      line2: "Nothing trades meanwhile.",
    });
    expect(m.slots.every((s) => s.side === null)).toBe(true);
  });

  it("retrying: 3 refused moves in a row, before Paused; no back-off, the next check is the next round", () => {
    const m = card({ refused: 3 }, { holdings: holdings(DRIFTED), debtUsd: 1_300 });
    expect(m.pill).toEqual({ text: "Retrying", tone: "due" });
    expect(m.footer).toEqual({
      kind: "words",
      line1: "Your agents’ last 3 runs didn’t go through.",
      line2: `Nothing moved. Next check ${next}.`,
    });
    expect(card({ refused: 2 }).pill.text).toBe("On");
  });

  it("paced: trades due after a session today wait for its 20 hours, unless the mix is new (decision 4)", () => {
    const sessionAt = WED_NOON - 2 * 3_600;
    const waits = card({}, { holdings: holdings(DRIFTED), pacing: { sessionAt, mixSetAt: 0 } });
    const at = whenText(nextRound(sessionAt + REBALANCE_GAP_SEC - 1), WED_NOON);
    expect(waits.footer).toMatchObject({
      kind: "trades",
      text: "3 trades",
      when: at.charAt(0).toUpperCase() + at.slice(1),
    });
    const fresh = card({}, { holdings: holdings(DRIFTED), pacing: { sessionAt, mixSetAt: WED_NOON - 60 } });
    expect(fresh.footer).toMatchObject({ kind: "trades", when: next.charAt(0).toUpperCase() + next.slice(1) });
  });

  it("off: faded, with what it does and how often it trades", () => {
    const m = card({ status: "off" });
    expect(m.pill).toEqual({ text: "Off", tone: "neutral" });
    expect(m.faded).toBe(true);
    expect(m.footer).toEqual({
      kind: "words",
      line1: "When on, it keeps your mix on target.",
      line2: "Trades at most once a day, or on a new mix.",
    });
  });

  it("off and coming soon: the whole portfolio now, backing shares included, not the saved mix", () => {
    // Free: NVIDIA only. Backing credit: Apple, Alphabet and Tesla (Oulina's account, 2026-10-20).
    const held: MixHolding[] = holdings([0, 0, 0, 0, 0, 25, 0]).map((h) => ({
      ...h,
      backingRaw:
        h.reserveId === 0 || h.reserveId === 2 || h.reserveId === 6
          ? holdings([25, 0, 25, 0, 0, 0, 25])[h.reserveId].freeRaw
          : 0n,
    }));
    const owned = [
      { reserveId: 0, targetBps: 2_500, offset: 0, side: null, out: null },
      { reserveId: 2, targetBps: 2_500, offset: 0, side: null, out: null },
      { reserveId: 5, targetBps: 2_500, offset: 0, side: null, out: null },
      { reserveId: 6, targetBps: 2_500, offset: 0, side: null, out: null },
    ];
    expect(card({ status: "off", holdings: held }).slots).toEqual(owned);
    expect(card({ live: false, holdings: held }).slots).toEqual(owned);
    // On, it draws the mix it keeps: the whole portfolio, backing shares too, against the targets.
    expect(card({ holdings: held }).slots.map((x) => x.reserveId)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("slots draw ×1.5 for 1–4 stocks and at the boards' size for 5–7 (board 7l)", () => {
    expect([1, 2, 3, 4].map(mixScale)).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect([5, 6, 7].map(mixScale)).toEqual([1, 1, 1]);
  });

  it("stopped on its own: before Off, faded", () => {
    const m = card({ status: "off", stoppedAt: WED_NOON - 2 * DAY, refused: 8 });
    expect(m.pill).toEqual({ text: "Stopped", tone: "needs" });
    expect(m.faded).toBe(true);
    expect(m.footer).toEqual({
      kind: "words",
      line1: `Stopped on ${dateOf(WED_NOON - 2 * DAY)}. Nothing trades now.`,
      line2: null,
    });
  });

  it("needs you: a grant whose registration is still to go comes first, faded", () => {
    for (const over of [{ status: "starting" as const }, { waiting: true, status: "off" as const, stoppedAt: 1 }]) {
      const m = card(over);
      expect(m.pill).toEqual({ text: "Needs you", tone: "needs" });
      expect(m.faded).toBe(true);
      expect(m.footer).toEqual({
        kind: "words",
        line1: "One more Face ID turns it on.",
        line2: "Until then, nothing trades.",
      });
    }
  });

  it("coming soon while the agents aren't live, whatever else applies", () => {
    const m = card({ live: false, status: "unconfigured", waiting: true, refused: 4 });
    expect(m.pill).toEqual({ text: "Coming soon", tone: "neutral" });
    expect(m.faded).toBe(true);
  });

  it("no mix saved: the stocks held now, and no mix yet once on", () => {
    const m = card({ mixBps: null }, { mixBps: null });
    expect(m.footer).toEqual({ kind: "words", line1: "No mix yet.", line2: null });
    expect(m.slots.every((s) => s.offset === 0)).toBe(true);
  });

  it("draws nothing yet while its state loads", () => {
    expect(rebalanceCard(input({ status: "loading" }))).toBeNull();
  });

  it("is faded exactly when Rebalancer isn't running", () => {
    const faded = (over: Partial<RebalanceCardInput>, at?: Partial<OutlookInput>) => card(over, at).faded;
    expect(faded({})).toBe(false);
    expect(faded({ refused: 3 })).toBe(false);
    expect(faded({ endsAt: WED_NOON + DAY })).toBe(false);
    expect(faded({}, { holdings: holdings(DRIFTED), debtUsd: 1_300 })).toBe(false);
    expect(faded({ status: "off" })).toBe(true);
    expect(faded({ status: "starting" })).toBe(true);
    expect(faded({ live: false })).toBe(true);
  });
});

describe("top-ups going in: the card and the sheet's line show what the next round puts into the mix", () => {
  const TWO = [0, 0, 0, 0, 0, 6_000, 4_000];
  /** $300 in the wallet above $1 and above what Keep still needs: the Planner's `topUpsReady`. */
  const topUps = (usd = 300): CardTopUps => ({ readyRaw: usdc(usd) });
  const two = { holdings: holdings([0, 0, 0, 0, 0, 60, 40]), mixBps: TWO };
  const investCard = (t: CardTopUps | null, over: Partial<RebalanceCardInput> = {}, at: Partial<OutlookInput> = two) =>
    card({ topUps: t, ...over }, at);
  const buys = (m: ReturnType<typeof card>) => m.slots.filter((s) => s.side).map((s) => [s.reserveId, s.side]);
  const dollars = (raw: bigint) => Number(raw) / 1e6;

  it("buys what's furthest below its target with the top-up (the Planner's invest rule)", () => {
    // 60/40 on target, $300 in: targets $6,180 and $4,120, so $180 of NVIDIA and $120 of Tesla (to a unit: the
    // fixture's shares are rounded).
    const trades = investDue({ ...two, options, topUps: topUps() });
    expect(trades.map((t) => [t.reserveId, t.buy])).toEqual([
      [5, true],
      [6, true],
    ]);
    expect(dollars(trades[0].amountIn)).toBeCloseTo(180, 5);
    expect(dollars(trades[1].amountIn)).toBeCloseTo(120, 5);
  });

  it("shows the top-up going in at the next round: the green pill, the time, BUY on the stocks it buys", () => {
    const m = investCard(topUps());
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.footer).toEqual({
      kind: "invest",
      text: "$300 going in",
      when: next.charAt(0).toUpperCase() + next.slice(1),
    });
    expect(buys(m)).toEqual([
      [5, "buy"],
      [6, "buy"],
    ]);
    expect(m.label).toBe(`Rebalancer, on. $300 going in ${next}. Buys NVIDIA and Tesla.`);
    expect(sheetLine(m)).toEqual({ text: `$300 going in ${next}. Buys NVIDIA and Tesla.`, renew: false });
  });

  it("is never held back by the pacing: a top-up goes in at the next round after a session today", () => {
    const m = investCard(topUps(), {}, { ...two, pacing: { sessionAt: WED_NOON - 2 * 3_600, mixSetAt: 0 } });
    expect(m.footer).toMatchObject({ kind: "invest", when: next.charAt(0).toUpperCase() + next.slice(1) });
  });

  it("shows the top-up, not the band trades, when both are due: it goes in first", () => {
    // "Coin hop": NVIDIA past its band. $300 in: Apple is furthest below its target ($2,060 against $1,600).
    const m = investCard(topUps(), {}, { holdings: holdings(DRIFTED) });
    expect(m.footer).toMatchObject({ kind: "invest", text: "$300 going in" });
    expect(buys(m)).toEqual([[0, "buy"]]);
    expect(card({}, { holdings: holdings(DRIFTED) }).footer).toMatchObject({ kind: "trades", text: "3 trades" });
  });

  it("puts all of it in: no trade is too small (the Planner's minTrade is 0)", () => {
    const m = card({ topUps: topUps() });
    expect(m.footer).toMatchObject({ kind: "invest", text: "$300 going in" });
    expect(investCard(topUps(15)).footer).toMatchObject({ kind: "invest", text: "$15 going in" });
  });

  it("shows nothing going in with nothing waiting, top-ups off, or no mix", () => {
    expect(investCard(topUps(0)).footer.kind).toBe("on-target");
    expect(investCard(null).footer.kind).toBe("on-target");
    expect(card({ topUps: topUps(), mixBps: null }, { mixBps: null }).footer).toEqual({
      kind: "words",
      line1: "No mix yet.",
      line2: null,
    });
  });

  it("waits in Act, and says so while retrying, with the buys still marked", () => {
    // $1,300 owed on $2,000 at 70%: in Act, on target, so only the top-up would trade.
    const paused = investCard(topUps(), {}, { ...two, debtUsd: 1_300 });
    expect(paused.pill).toEqual({ text: "Paused", tone: "neutral" });
    expect(paused.slots.every((s) => s.side === null)).toBe(true);
    const retrying = investCard(topUps(), { refused: 3 });
    expect(retrying.pill.text).toBe("Retrying");
    expect(buys(retrying)).toEqual([
      [5, "buy"],
      [6, "buy"],
    ]);
  });
});

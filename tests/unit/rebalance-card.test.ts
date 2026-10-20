import { describe, expect, it } from "vitest";
import { mixBpsNow, rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import { rebalanceCheckAt, rebalanceOutlook, whenText, type OutlookInput } from "@/lib/agents/next";
import { mixSlots, OFFSET_MAX, rebalanceCard, type RebalanceCardInput } from "@/lib/agents/rebalanceCard";
import { bandOf } from "@/lib/agents/rules/rebalance";

const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const CAP_MAX = usdc(1_000_000);
/** Wednesday 2025-10-15 12:00 New York (16:00 UTC, daylight time). */
const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;
const DAY = 86_400;

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
    capMaxRaw: CAP_MAX,
    rebalanceDay: 0,
    debtUsd: 600,
    totalBackingUsd: 2_000,
    avgCf: 0.7,
    left: { rebalance: null },
    capRaw: { rebalance: CAP_MAX },
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
    fails: 0,
    cooldownUntil: 0,
    rebalanceDay: 0,
    holdings: o.holdings,
    mixBps: o.mixBps,
    options,
    outlook: rebalanceOutlook(o),
    ...over,
  };
}
const card = (over?: Partial<RebalanceCardInput>, at?: Partial<OutlookInput>) => rebalanceCard(input(over, at))!;
const next = whenText(rebalanceCheckAt(WED_NOON, 0), WED_NOON); // "tomorrow 10:00 AM" in the viewer's own time

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
      { reserveId: 5, targetBps: 7_500, offset: 0, side: null },
      { reserveId: 6, targetBps: 2_500, offset: 0, side: null },
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
      checkAt: rebalanceCheckAt(WED_NOON, 0),
      waitsInAct: false,
    });
    expect(rebalanceOutlook(outlookIn({ mixBps: null }))).toMatchObject({ noMix: true, trades: [] });
    const drifted = rebalanceOutlook(outlookIn({ holdings: holdings(DRIFTED) }));
    expect(drifted.trades.map((t) => [t.reserveId, t.buy])).toEqual([
      [5, false],
      [0, true],
      [3, true],
    ]);
    // $1,300 owed on $2,000 at 70%: health 1.08, in Act.
    expect(rebalanceOutlook(outlookIn({ holdings: holdings(DRIFTED), debtUsd: 1_300 })).waitsInAct).toBe(true);
    // In Act but nothing to trade: it doesn't wait for anything.
    expect(rebalanceOutlook(outlookIn({ debtUsd: 1_300 })).waitsInAct).toBe(false);
  });
});

describe("rebalanceCard: the first state that applies, in board 7's order, with its words", () => {
  it("all good: On, the green On target and the next check", () => {
    const m = card();
    expect(m.pill).toEqual({ text: "On", tone: "on" });
    expect(m.faded).toBe(false);
    expect(m.footer).toEqual({ kind: "on-target", next: next.charAt(0).toUpperCase() + next.slice(1) });
    expect(m.label).toBe(`Rebalance, on. On target. Next check ${next}.`);
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
    expect(m.label).toBe(`Rebalance, on. 3 trades ${next}. Sells NVIDIA. Buys Apple and Meta.`);
  });

  it("ends soon: within a week of its grant's end, on target", () => {
    const m = card({ endsAt: WED_NOON + 4 * DAY });
    expect(m.pill).toEqual({ text: "Ends soon", tone: "due" });
    expect(m.footer).toEqual({
      kind: "words",
      line1: "Ends on Oct 19. Then nothing trades.",
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

  it("retrying: 3 failed runs in a row, before Paused; a back-off moves the next check", () => {
    const m = card({ fails: 3 }, { holdings: holdings(DRIFTED), debtUsd: 1_300 });
    expect(m.pill).toEqual({ text: "Retrying", tone: "due" });
    expect(m.footer).toEqual({
      kind: "words",
      line1: "Your agents’ last 3 runs didn’t go through.",
      line2: `Nothing moved. Next check ${next}.`,
    });
    const later = WED_NOON + 2 * DAY;
    const backedOff = card({ fails: 5, cooldownUntil: later });
    expect(backedOff.footer).toMatchObject({
      line2: `Nothing moved. Next check ${whenText(rebalanceCheckAt(later, 0), WED_NOON)}.`,
    });
    expect(card({ fails: 2 }).pill.text).toBe("On");
  });

  it("off: faded, with what it does and when it checks", () => {
    const m = card({ status: "off" });
    expect(m.pill).toEqual({ text: "Off", tone: "neutral" });
    expect(m.faded).toBe(true);
    expect(m.footer).toEqual({
      kind: "words",
      line1: "When on, it keeps your mix on target.",
      line2: "Checks once a market day, after the US open.",
    });
  });

  it("stopped on its own: before Off, faded", () => {
    const m = card({ status: "off", stoppedAt: WED_NOON - 2 * DAY, fails: 8 });
    expect(m.pill).toEqual({ text: "Stopped", tone: "needs" });
    expect(m.faded).toBe(true);
    expect(m.footer).toEqual({ kind: "words", line1: "Stopped on Oct 13. Nothing trades now.", line2: null });
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
    const m = card({ live: false, status: "unconfigured", waiting: true, fails: 4 });
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

  it("is faded exactly when Rebalance isn't running", () => {
    const faded = (over: Partial<RebalanceCardInput>, at?: Partial<OutlookInput>) => card(over, at).faded;
    expect(faded({})).toBe(false);
    expect(faded({ fails: 3 })).toBe(false);
    expect(faded({ endsAt: WED_NOON + DAY })).toBe(false);
    expect(faded({}, { holdings: holdings(DRIFTED), debtUsd: 1_300 })).toBe(false);
    expect(faded({ status: "off" })).toBe(true);
    expect(faded({ status: "starting" })).toBe(true);
    expect(faded({ live: false })).toBe(true);
  });
});

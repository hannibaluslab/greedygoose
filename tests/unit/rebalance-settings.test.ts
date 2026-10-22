import { describe, expect, it } from "vitest";
import { rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import { nextRound, rebalanceOutlook, whenText, type OutlookInput } from "@/lib/agents/next";
import { NO_LIMIT, type StockLimits } from "@/lib/agents/permissions";
import { rebalanceCard, type RebalanceCardInput } from "@/lib/agents/rebalanceCard";
import { rebalanceAllows, rebalanceSave, rebalanceSteps, savedText, sheetLine } from "@/lib/agents/rebalanceSettings";

describe("rebalanceSave", () => {
  const mix = [2_500, 0, 0, 0, 0, 5_000, 2_500];
  const limits: StockLimits = [NO_LIMIT, 0n, 0n, 0n, 0n, NO_LIMIT, NO_LIMIT];
  const base = {
    configured: true,
    connected: true,
    saved: mix,
    weights: mix,
    terms: { limitsRaw: limits },
    running: true,
    feeBlocked: false,
    feeLoading: false,
    busy: false,
  };

  it("says Not live yet and saves nothing without a Guard", () => {
    expect(rebalanceSave({ ...base, configured: false, saved: null, terms: null })).toEqual({
      mixChanged: false,
      topUpsChanged: false,
      needsGrant: false,
      steps: 0,
      canSave: false,
      note: "Not live yet",
      allows: null,
      keeps: null,
    });
  });

  it("has nothing to save when the mix is what it runs with", () => {
    expect(rebalanceSave(base)).toMatchObject({ steps: 0, canSave: false, note: null });
  });

  it("takes one batch for a new mix in stocks it may already sell", () => {
    const weights = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...base, weights })).toMatchObject({
      mixChanged: true,
      needsGrant: false,
      steps: 1,
      canSave: true,
      note: null,
    });
  });

  it("takes one batch for a stock the grant can't sell yet: the new grant and the mix together", () => {
    const weights = [2_500, 2_500, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...base, weights })).toMatchObject({
      mixChanged: true,
      needsGrant: true,
      steps: 1,
      note: null,
    });
  });

  it("switches it on with the first mix", () => {
    expect(rebalanceSave({ ...base, saved: [0, 0, 0, 0, 0, 0, 0], terms: null, running: false })).toMatchObject({
      steps: 1,
      canSave: true,
      note: null,
    });
    expect(rebalanceSave({ ...base, terms: null, running: false })).toMatchObject({
      steps: 1,
      canSave: true,
      note: null,
    });
  });

  it("says what the Face ID lets Rebalancer do above Save only while Save grants", () => {
    const narrow = { ...base, terms: { limitsRaw: limits.map((l, r) => (r === 6 ? 0n : l)) } };
    expect(rebalanceSave(narrow).allows).toBe(rebalanceAllows());
    expect(rebalanceSave({ ...base, terms: null, running: false }).allows).toBe(rebalanceAllows());
    expect(rebalanceSave({ ...base, weights: [5_000, 0, 0, 0, 0, 2_500, 2_500] }).allows).toBeNull();
    expect(rebalanceSave(base).allows).toBeNull();
  });

  it("stays disabled until the mix adds up to 100%", () => {
    const weights = [2_500, 0, 0, 0, 0, 4_000, 2_500];
    expect(rebalanceSave({ ...base, weights })).toMatchObject({
      canSave: false,
      note: "Make your mix add up to 100% to save it.",
    });
  });

  it("stays disabled while fees can't be paid, it's busy, or signed out", () => {
    const weights = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...base, weights, feeBlocked: true })).toMatchObject({
      canSave: false,
      note: "Your account can’t pay network fees from your cash right now.",
    });
    expect(rebalanceSave({ ...base, weights, busy: true }).canSave).toBe(false);
    expect(rebalanceSave({ ...base, weights, feeLoading: true }).canSave).toBe(false);
    expect(rebalanceSave({ ...base, weights, connected: false }).canSave).toBe(false);
  });
});

describe('rebalanceSteps: Save is one batch, one Face ID (Adrian, 2026-10-20: "in one signature")', () => {
  it("one batch when the grant or the mix changed, nothing otherwise", () => {
    expect(rebalanceSteps({ needsGrant: true, mixChanged: true })).toEqual(["batch"]);
    expect(rebalanceSteps({ needsGrant: true, mixChanged: false })).toEqual(["batch"]);
    expect(rebalanceSteps({ needsGrant: false, mixChanged: true })).toEqual(["batch"]);
    expect(rebalanceSteps({ needsGrant: false, mixChanged: false })).toEqual([]);
  });

  it("sends a top-ups change in the same one batch, alone or with a new grant", () => {
    const only = { needsGrant: false, mixChanged: false, topUpsChanged: true };
    expect(rebalanceSteps(only)).toEqual(["batch"]);
    expect(rebalanceSteps({ ...only, needsGrant: true })).toEqual(["batch"]);
    expect(rebalanceSteps({ ...only, mixChanged: true })).toEqual(["batch"]);
    expect(rebalanceSteps({ ...only, topUpsChanged: false })).toEqual([]);
  });

  it("says what the Face ID lets Rebalancer do, and that it never spends cash until top-ups are on", () => {
    expect(rebalanceAllows()).toBe(
      "Rebalancer can trade your stocks toward your mix, for a year. It never spends your cash. You can turn it off here.",
    );
    expect(rebalanceAllows({ keepUsd: 500 })).toMatch(/put your top-ups above \$500 into it/);
    expect(rebalanceAllows({ keepUsd: 500 })).not.toMatch(/never spends/);
    expect(rebalanceAllows({ keepUsd: 0 })).toMatch(/put every top-up into it/);
  });

  it("ends on the turn-off, naming Rebalancer only when earning's words come before it", () => {
    expect(rebalanceAllows({ keepUsd: 500 })).toMatch(/for a year\. You can turn it off here\.$/);
    expect(rebalanceAllows({ keepUsd: 0 }, true)).toBe(
      "Rebalancer can trade your stocks toward your mix, and put every top-up into it, for a year. " +
        "New cash that arrives moves into savings on its own. You can turn Rebalancer off here.",
    );
  });
});

describe("rebalanceSave: Top-ups go into my mix (a setting in GooseGuard: no new grant to switch them)", () => {
  const mix = [2_500, 0, 0, 0, 0, 5_000, 2_500];
  const limits: StockLimits = [NO_LIMIT, 0n, 0n, 0n, 0n, NO_LIMIT, NO_LIMIT];
  const off = { on: false, keepUsd: 500 };
  const on = { on: true, keepUsd: 500 };
  const base = {
    configured: true,
    connected: true,
    saved: mix,
    weights: mix,
    terms: { limitsRaw: limits },
    running: true,
    feeBlocked: false,
    feeLoading: false,
    busy: false,
  };

  it("has nothing to save while the setting is what the Guard has", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: off, chosen: off } })).toMatchObject({ steps: 0, canSave: false });
    expect(rebalanceSave({ ...base, topUps: { saved: on, chosen: on } })).toMatchObject({ steps: 0 });
  });

  it("turns them on with the setting alone: Save, one batch, no new grant (board 7f)", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: off, chosen: on } })).toMatchObject({
      topUpsChanged: true,
      needsGrant: false,
      steps: 1,
      canSave: true,
      note: null,
      allows: null,
    });
  });

  it("turns them off with the setting alone, running or not", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: on, chosen: off } })).toMatchObject({
      topUpsChanged: true,
      needsGrant: false,
      steps: 1,
      canSave: true,
    });
    const stopped = { ...base, terms: null, running: false };
    expect(rebalanceSave({ ...stopped, topUps: { saved: on, chosen: off } })).toMatchObject({
      needsGrant: false,
      steps: 1,
      allows: null,
    });
    // Turning Rebalance on stays a grant: nothing changed, the mix changed too, or top-ups left on.
    expect(rebalanceSave({ ...stopped, topUps: { saved: on, chosen: on } })).toMatchObject({ needsGrant: true });
    expect(
      rebalanceSave({ ...stopped, weights: [5_000, 0, 0, 0, 0, 2_500, 2_500], topUps: { saved: on, chosen: off } }),
    ).toMatchObject({ needsGrant: true });
  });

  it("says what a grant lets Rebalancer do, from the switch as chosen, and earning's words while it's off (P3)", () => {
    const weights = [2_500, 0, 0, 0, 2_500, 2_500, 2_500]; // Microsoft it may not sell yet: a new grant
    expect(rebalanceSave({ ...base, weights, topUps: { saved: on, chosen: on } }).allows).toBe(
      rebalanceAllows({ keepUsd: 500 }),
    );
    expect(rebalanceSave({ ...base, weights, topUps: { saved: off, chosen: off } }).allows).toBe(rebalanceAllows());
    expect(rebalanceSave({ ...base, weights, earningOff: true, topUps: { saved: off, chosen: on } }).allows).toBe(
      "Rebalancer can trade your stocks toward your mix, and put your top-ups above $500 into it, for a year. " +
        "New cash that arrives moves into savings on its own. You can turn Rebalancer off here.",
    );
  });

  it("saves Keep alone as a settings-only change, no new grant (board 7h)", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: on, chosen: { on: true, keepUsd: 0 } } })).toMatchObject({
      mixChanged: false,
      topUpsChanged: true,
      needsGrant: false,
      steps: 1,
      canSave: true,
      allows: null,
    });
  });

  it("waits for an amount while Keep is empty", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: on, chosen: { on: true, keepUsd: null } } })).toMatchObject({
      steps: 1,
      canSave: false,
      note: "Enter an amount",
    });
  });

  it("counts nothing about top-ups until the Guard's setting is read, or without a Guard", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: null, chosen: on } })).toMatchObject({
      topUpsChanged: false,
      needsGrant: false,
      steps: 0,
    });
    expect(
      rebalanceSave({ ...base, configured: false, saved: null, terms: null, topUps: { saved: off, chosen: on } }),
    ).toMatchObject({ topUpsChanged: false, steps: 0 });
  });

  it("holds a Save that grants until the switch is read: the grant's line says whether top-ups go in", () => {
    const weights = [2_500, 0, 0, 0, 2_500, 2_500, 2_500];
    const plan = rebalanceSave({ ...base, weights, topUps: { saved: null, chosen: on } });
    expect(plan).toMatchObject({ needsGrant: true, steps: 1, canSave: false, note: "One moment…", allows: null });
    expect(rebalanceSave({ ...base, weights, topUps: { saved: on, chosen: on } })).toMatchObject({
      canSave: true,
      note: null,
      allows: rebalanceAllows({ keepUsd: 500 }),
    });
    // A Save that grants nothing doesn't wait.
    const mixOnly = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...base, weights: mixOnly, topUps: { saved: null, chosen: on } })).toMatchObject({
      needsGrant: false,
      canSave: true,
      note: null,
    });
  });

  it("says a waiting top-up stays as cash only when the Save switches top-ups off", () => {
    const waiting = { waitingUsd: 300 };
    expect(rebalanceSave({ ...base, ...waiting, topUps: { saved: on, chosen: off } }).keeps).toBe(
      "The $300 waiting stays as cash.",
    );
    expect(rebalanceSave({ ...base, waitingUsd: 300.5, topUps: { saved: on, chosen: off } }).keeps).toBe(
      "The $300.50 waiting stays as cash.",
    );
    // A new grant, Keep alone or the mix alone keeps it going in: nothing to say. Nor with nothing waiting.
    const newStock = [2_500, 0, 0, 0, 2_500, 2_500, 2_500];
    expect(
      rebalanceSave({ ...base, ...waiting, weights: newStock, topUps: { saved: on, chosen: on } }).keeps,
    ).toBeNull();
    expect(
      rebalanceSave({ ...base, ...waiting, topUps: { saved: on, chosen: { on: true, keepUsd: 900 } } }).keeps,
    ).toBeNull();
    expect(rebalanceSave({ ...base, waitingUsd: null, topUps: { saved: on, chosen: off } }).keeps).toBeNull();
  });

  it("puts a mix change and a top-ups change in the same batch", () => {
    const weights = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(
      rebalanceSave({ ...base, weights, topUps: { saved: on, chosen: { on: true, keepUsd: 900 } } }),
    ).toMatchObject({ mixChanged: true, topUpsChanged: true, needsGrant: false, steps: 1 });
  });
});

describe("savedText: the toast once a Save lands", () => {
  const plan = { mixChanged: false, topUpsChanged: false, needsGrant: false };
  it("says the mix is saved only when the mix changed", () => {
    expect(savedText({ ...plan, mixChanged: true }, true)).toBe("Your mix is saved");
    expect(savedText({ ...plan, mixChanged: true, topUpsChanged: true, needsGrant: true }, true)).toBe(
      "Your mix is saved",
    );
  });

  it("says top-ups are saved for Keep alone or the switch alone", () => {
    expect(savedText({ ...plan, topUpsChanged: true }, true)).toBe("Top-ups saved"); // Keep, no grant
    expect(savedText({ ...plan, topUpsChanged: true, needsGrant: true }, true)).toBe("Top-ups saved"); // the switch
    expect(savedText({ ...plan, topUpsChanged: true }, false)).toBe("Top-ups saved"); // off alone, Rebalancer stopped
  });

  it("says Rebalancer is on when the Save turned it on, and Saved for a grant alone", () => {
    expect(savedText({ ...plan, needsGrant: true }, false)).toBe("Rebalancer is on");
    expect(savedText({ ...plan, topUpsChanged: true, needsGrant: true }, false)).toBe("Rebalancer is on");
    expect(savedText({ ...plan, needsGrant: true }, true)).toBe("Saved");
  });
});

describe("sheetLine: the line under the sheet's title, from Rebalancer's card", () => {
  /** Wednesday 2025-10-15 12:00 New York (16:00 UTC). */
  const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;
  const DAY = 86_400;
  const PRICES = [250, 220, 180, 700, 500, 180, 400];
  const MIX = [2_000, 1_000, 1_000, 1_000, 1_500, 2_500, 1_000];
  const holdings = (pcts: readonly number[]): MixHolding[] =>
    PRICES.map((p, reserveId) => ({
      reserveId,
      priceRaw: BigInt(Math.round(p * 1e8)),
      freeRaw: BigInt(Math.round(((pcts[reserveId] / 100) * 10_000 * 1e8) / p)),
    }));
  const options = rebalanceOptions();
  const card = (over: Partial<RebalanceCardInput> = {}, pcts = [20, 10, 10, 10, 15, 26, 9], debtUsd = 600) => {
    const o: OutlookInput = {
      nowSec: WED_NOON,
      holdings: holdings(pcts),
      mixBps: MIX,
      pacing: { sessionAt: 0, mixSetAt: 0 },
      debtUsd,
      totalBackingUsd: 2_000,
      avgCf: 0.7,
      numbers: { rebalance: options },
    };
    return rebalanceCard({
      live: true,
      nowSec: WED_NOON,
      status: "on",
      waiting: false,
      stoppedAt: null,
      endsAt: WED_NOON + 200 * DAY,
      refused: 0,
      holdings: o.holdings,
      mixBps: MIX,
      options,
      outlook: rebalanceOutlook(o),
      ...over,
    })!;
  };
  // The next round in the viewer's own time ("today 12:10 PM GMT-4").
  const next = whenText(nextRound(WED_NOON), WED_NOON);

  it("says it's on target and when it checks, as boards 7e–7h do", () => {
    expect(sheetLine(card())).toEqual({ text: `On target. Checks ${next}.`, renew: false });
  });

  it("names the trades due and their stocks", () => {
    expect(sheetLine(card({}, [16, 10, 10, 8, 15, 32, 9]))).toEqual({
      text: `3 trades ${next}. Sells NVIDIA. Buys Apple and Meta.`,
      renew: false,
    });
  });

  it("offers Renew while the grant ends within the week", () => {
    expect(sheetLine(card({ endsAt: WED_NOON + 4 * DAY }))).toMatchObject({ renew: true });
    expect(sheetLine(card({ endsAt: WED_NOON + 4 * DAY })).text).toMatch(
      /^Ends on .+\. Then nothing trades\. On target/,
    );
    expect(sheetLine(card({ endsAt: WED_NOON + 8 * DAY }))).toMatchObject({ renew: false });
  });

  it("offers Renew in the grant's last week even behind trades due or a pause (Adrian, 2026-10-20)", () => {
    const ends = { endsAt: WED_NOON + 4 * DAY };
    const due = sheetLine(card(ends, [16, 10, 10, 8, 15, 32, 9]));
    expect(due.text).toMatch(/^3 trades /);
    expect(due.renew).toBe(true);
    // $1,300 owed against $2,000 backing at 70%: health about 1.08, in Act, so the trades due wait.
    const paused = sheetLine(card(ends, [16, 10, 10, 8, 15, 32, 9], 1_300));
    expect(paused.text).toMatch(/^Waits until your credit is out of Act/);
    expect(paused.renew).toBe(true);
  });

  it("says the state's own words otherwise", () => {
    expect(sheetLine(card({ status: "off" }))).toEqual({
      text: "When on, it keeps your mix on target. Trades at most once a day, or on a new mix.",
      renew: false,
    });
    expect(sheetLine(card({ status: "starting", waiting: true }))).toEqual({
      text: "One more Face ID turns it on. Until then, nothing trades.",
      renew: false,
    });
  });
});

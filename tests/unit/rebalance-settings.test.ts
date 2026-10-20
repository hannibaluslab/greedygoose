import { describe, expect, it } from "vitest";
import { rebalanceOptions, type MixHolding } from "@/lib/agents/mix";
import { rebalanceCheckAt, rebalanceOutlook, whenText, type OutlookInput } from "@/lib/agents/next";
import type { StockLimits } from "@/lib/agents/permissions";
import { rebalanceCard, type RebalanceCardInput } from "@/lib/agents/rebalanceCard";
import { rebalanceAllows, rebalanceSave, rebalanceSteps, sheetLine } from "@/lib/agents/rebalanceSettings";

const usdc = (usd: number) => BigInt(usd) * 10n ** 6n;

describe("rebalanceSave", () => {
  const mix = [2_500, 0, 0, 0, 0, 5_000, 2_500];
  const limits: StockLimits = [1n, 0n, 0n, 0n, 0n, 1n, 1n];
  const base = {
    configured: true,
    connected: true,
    saved: mix,
    weights: mix,
    terms: { capRaw: usdc(10_000), limitsRaw: limits },
    capMaxRaw: usdc(10_000),
    running: true,
    feeBlocked: false,
    feeLoading: false,
    busy: false,
  };

  it("says Not live yet and saves nothing without an executor", () => {
    expect(rebalanceSave({ ...base, configured: false, saved: null, terms: null })).toEqual({
      mixChanged: false,
      topUpsChanged: false,
      needsGrant: false,
      steps: 0,
      canSave: false,
      note: "Not live yet",
      allows: null,
    });
  });

  it("has nothing to save when the mix is what it runs with, on a grant at CAP_MAX", () => {
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

  it("needs a new grant at CAP_MAX for a capped grant from before: one batch, approved and registered", () => {
    const capped = { ...base, terms: { capRaw: usdc(100), limitsRaw: limits } };
    expect(rebalanceSave(capped)).toMatchObject({
      mixChanged: false,
      needsGrant: true,
      steps: 1,
      canSave: true,
      note: null,
    });
    // Until CAP_MAX is read nothing saves, and the grant isn't judged capped yet.
    expect(rebalanceSave({ ...capped, capMaxRaw: null })).toMatchObject({ needsGrant: false, canSave: false });
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

  it("says what the Face ID lets Rebalance do above Save only while Save grants", () => {
    const capped = { ...base, terms: { capRaw: usdc(100), limitsRaw: limits } };
    expect(rebalanceSave(capped).allows).toBe(rebalanceAllows());
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
    expect(rebalanceSave({ ...base, weights, capMaxRaw: null }).canSave).toBe(false);
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

  it("says what the Face ID lets Rebalance do, and that it never spends cash until top-ups are on", () => {
    expect(rebalanceAllows()).toBe(
      "Rebalance can trade your stocks toward your mix, for a year. It never spends your cash. You can turn it off here.",
    );
    expect(rebalanceAllows({ keepUsd: 500 })).toMatch(/put your top-ups above \$500 into it/);
    expect(rebalanceAllows({ keepUsd: 500 })).not.toMatch(/never spends/);
    expect(rebalanceAllows({ keepUsd: 0 })).toMatch(/put every top-up into it/);
  });

  it("ends on the turn-off, naming Rebalance only when earning's words come before it", () => {
    expect(rebalanceAllows({ keepUsd: 500 })).toMatch(/for a year\. You can turn it off here\.$/);
    expect(rebalanceAllows({ keepUsd: 0 }, true)).toBe(
      "Rebalance can trade your stocks toward your mix, and put every top-up into it, for a year. " +
        "New cash that arrives moves into savings on its own. You can turn Rebalance off here.",
    );
  });
});

describe("rebalanceSave: Top-ups go into my mix", () => {
  const mix = [2_500, 0, 0, 0, 0, 5_000, 2_500];
  const limits: StockLimits = [1n, 0n, 0n, 0n, 0n, 1n, 1n];
  const off = { on: false, keepUsd: 500 };
  const on = { on: true, keepUsd: 500 };
  const base = {
    configured: true,
    connected: true,
    saved: mix,
    weights: mix,
    terms: { capRaw: usdc(10_000), limitsRaw: limits, topUps: false },
    capMaxRaw: usdc(10_000),
    running: true,
    feeBlocked: false,
    feeLoading: false,
    busy: false,
  };
  const withWithdraw = { ...base, terms: { ...base.terms, topUps: true } };

  it("has nothing to save while the setting is what the executor has", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: off, chosen: off } })).toMatchObject({ steps: 0, canSave: false });
    expect(rebalanceSave({ ...withWithdraw, topUps: { saved: on, chosen: on } })).toMatchObject({ steps: 0 });
  });

  it("takes a new grant to turn them on, with the savings withdraw in it: Save, one batch (board 7f)", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: off, chosen: on } })).toMatchObject({
      topUpsChanged: true,
      needsGrant: true,
      steps: 1,
      canSave: true,
      note: null,
      allows: rebalanceAllows({ keepUsd: 500 }),
    });
    expect(rebalanceSave({ ...base, topUps: { saved: off, chosen: { on: true, keepUsd: 0 } } }).allows).toMatch(
      /put every top-up into it/,
    );
  });

  it("says earning turns on too when top-ups turn on while it's off: the same Face ID grants it (P3)", () => {
    const plan = rebalanceSave({ ...base, earningOff: true, topUps: { saved: off, chosen: on } });
    expect(plan).toMatchObject({ needsGrant: true, steps: 1, canSave: true });
    // Earning's words before the turn-off, which ends the line and names Rebalance; no amount limit (P2).
    expect(plan.allows).toBe(
      "Rebalance can trade your stocks toward your mix, and put your top-ups above $500 into it, for a year. " +
        "New cash that arrives moves into savings on its own. You can turn Rebalance off here.",
    );
    expect(plan.allows).toBe(rebalanceAllows({ keepUsd: 500 }, true));
    // A new grant with top-ups already on (a stock added to the mix) grants earning too while it's off.
    const weights = [2_500, 0, 0, 0, 2_500, 2_500, 2_500];
    expect(
      rebalanceSave({ ...withWithdraw, weights, earningOff: true, topUps: { saved: on, chosen: on } }).allows,
    ).toBe(plan.allows);
    // Earning already on, or top-ups turning off: Rebalance's line alone.
    expect(rebalanceSave({ ...base, topUps: { saved: off, chosen: on } }).allows).toBe(
      rebalanceAllows({ keepUsd: 500 }),
    );
    expect(rebalanceSave({ ...withWithdraw, earningOff: true, topUps: { saved: on, chosen: off } }).allows).toBe(
      rebalanceAllows(),
    );
  });

  it("takes a new grant without the withdraw to turn them off: one batch, the old grant revoked in it", () => {
    expect(rebalanceSave({ ...withWithdraw, topUps: { saved: on, chosen: off } })).toMatchObject({
      topUpsChanged: true,
      needsGrant: true,
      steps: 1,
      // The new grant has no withdraw, so the line says it never spends cash.
      allows: rebalanceAllows(),
    });
  });

  it("saves Keep alone as a settings-only change, no new grant (board 7h)", () => {
    expect(rebalanceSave({ ...withWithdraw, topUps: { saved: on, chosen: { on: true, keepUsd: 0 } } })).toMatchObject({
      mixChanged: false,
      topUpsChanged: true,
      needsGrant: false,
      steps: 1,
      canSave: true,
      allows: null,
    });
  });

  it("waits for an amount while Keep is empty, and says nothing it allows until one is typed", () => {
    expect(
      rebalanceSave({ ...withWithdraw, topUps: { saved: on, chosen: { on: true, keepUsd: null } } }),
    ).toMatchObject({ steps: 1, canSave: false, note: "Enter an amount" });
    // Turning them on with Keep emptied: a new grant, but no "every top-up" for an amount nobody typed.
    expect(rebalanceSave({ ...base, topUps: { saved: off, chosen: { on: true, keepUsd: null } } })).toMatchObject({
      needsGrant: true,
      canSave: false,
      note: "Enter an amount",
      allows: null,
    });
  });

  it("grants again when the grant lost the withdraw while top-ups are on", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: on, chosen: on } })).toMatchObject({
      topUpsChanged: false,
      needsGrant: true,
      steps: 1,
    });
  });

  it("counts nothing about top-ups until the executor's setting is read, or without an executor", () => {
    expect(rebalanceSave({ ...base, topUps: { saved: null, chosen: on } })).toMatchObject({
      topUpsChanged: false,
      needsGrant: false,
      steps: 0,
    });
    expect(
      rebalanceSave({ ...base, configured: false, saved: null, terms: null, topUps: { saved: off, chosen: on } }),
    ).toMatchObject({ topUpsChanged: false, steps: 0 });
  });

  it("holds a Save that grants while the running grant carries top-ups and the switch isn't read", () => {
    const weights = [2_500, 0, 0, 0, 2_500, 2_500, 2_500]; // Microsoft has no sell limit yet: a new grant
    for (const saved of [undefined, null]) {
      const plan = rebalanceSave({
        ...withWithdraw,
        weights,
        topUps: saved === undefined ? undefined : { saved, chosen: on },
      });
      expect(plan).toMatchObject({ needsGrant: true, steps: 1, canSave: false, note: "One moment…", allows: null });
    }
    // Read, the same Save goes ahead with the line for the grant it makes.
    expect(rebalanceSave({ ...withWithdraw, weights, topUps: { saved: on, chosen: on } })).toMatchObject({
      canSave: true,
      note: null,
      allows: rebalanceAllows({ keepUsd: 500 }),
    });
    // A grant without the withdraw: nothing to contradict, so it doesn't wait. Nor does a Save that grants nothing.
    expect(rebalanceSave({ ...base, weights, topUps: { saved: null, chosen: off } })).toMatchObject({
      canSave: true,
      allows: rebalanceAllows(),
    });
    const mixOnly = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(rebalanceSave({ ...withWithdraw, weights: mixOnly, topUps: { saved: null, chosen: on } })).toMatchObject({
      needsGrant: false,
      canSave: true,
      note: null,
    });
  });

  it("puts a mix change and a top-ups change in the same batch", () => {
    const weights = [5_000, 0, 0, 0, 0, 2_500, 2_500];
    expect(
      rebalanceSave({ ...withWithdraw, weights, topUps: { saved: on, chosen: { on: true, keepUsd: 900 } } }),
    ).toMatchObject({ mixChanged: true, topUpsChanged: true, needsGrant: false, steps: 1 });
  });
});

describe("sheetLine: the line under the sheet's title, from Rebalance's card", () => {
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
  const card = (over: Partial<RebalanceCardInput> = {}, pcts = [20, 10, 10, 10, 15, 26, 9]) => {
    const o: OutlookInput = {
      nowSec: WED_NOON,
      holdings: holdings(pcts),
      mixBps: MIX,
      capMaxRaw: usdc(1_000_000),
      rebalanceDay: 0,
      debtUsd: 600,
      totalBackingUsd: 2_000,
      avgCf: 0.7,
      left: { rebalance: null },
      capRaw: { rebalance: usdc(1_000_000) },
      numbers: { rebalance: options },
    };
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
      mixBps: MIX,
      options,
      outlook: rebalanceOutlook(o),
      ...over,
    })!;
  };
  // "tomorrow 10:00 AM" in the viewer's own time; a weekday keeps its capital ("Mon 10:00 AM").
  const next = whenText(rebalanceCheckAt(WED_NOON, 0), WED_NOON);

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
  });

  it("says the state's own words otherwise", () => {
    expect(sheetLine(card({ status: "off" }))).toEqual({
      text: "When on, it keeps your mix on target. Checks once a market day, after the US open.",
      renew: false,
    });
    expect(sheetLine(card({ status: "starting", waiting: true }))).toEqual({
      text: "One more Face ID turns it on. Until then, nothing trades.",
      renew: false,
    });
  });
});

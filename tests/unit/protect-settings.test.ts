import { describe, expect, it } from "vitest";
import { isAddressEqual, type Address } from "viem";
import {
  neverSellOf,
  protectSteps,
  savedChoice,
  sellLimitsFor,
  stepCount,
  withRegistration,
  type ProtectSaved,
} from "@/lib/agents/protect";
import { readAgentGrant, sellGrant, stockLimitsRaw, type ListedPermission } from "@/lib/agents/permissions";
import { EQUITIES } from "@/lib/tokens/registry";

const usdc = (x: number) => BigInt(x) * 10n ** 6n;
/** Aave's prices by reserve id: Apple $250, Amazon $220, Google $180, Meta $700, Microsoft $500, NVIDIA $180, Tesla $383. */
const PRICES = [250, 220, 180, 700, 500, 180, 383].map((p) => BigInt(p) * 10n ** 8n);
const CAP_MAX = usdc(10_000);
const ctx = { capMaxRaw: CAP_MAX, pricesRaw: PRICES };
const TESLA = 6;
const NVIDIA = 5;
const EXECUTOR = "0x00000000000000000000000000000000000e5ec0" as Address;

const off: ProtectSaved = { repayOn: false, sell: null, keepMix: false };
const sellAll = { limitsRaw: sellLimitsFor(CAP_MAX, PRICES, []) };
const fullOn: ProtectSaved = { repayOn: true, sell: sellAll, keepMix: false };

describe("Protect's never-sell grant", () => {
  it("leaves the never-sell stocks out of the sell grant: no approve, no limit", () => {
    const limitsRaw = sellLimitsFor(CAP_MAX, PRICES, [TESLA]);
    expect(limitsRaw[TESLA]).toBe(0n);
    expect(limitsRaw.filter((l) => l > 0n)).toHaveLength(EQUITIES.length - 1);
    expect(limitsRaw).toEqual(
      stockLimitsRaw(
        CAP_MAX,
        CAP_MAX,
        PRICES,
        EQUITIES.map((e) => e.reserveId !== TESLA),
      ),
    );

    const grant = sellGrant(CAP_MAX, limitsRaw);
    const tesla = EQUITIES[TESLA].address;
    expect(grant.calls!.some((c) => isAddressEqual(c.target, tesla))).toBe(false);
    expect(grant.spends!.some((s) => isAddressEqual(s.token, tesla))).toBe(false);
    expect(grant.calls!.some((c) => isAddressEqual(c.target, EQUITIES[NVIDIA].address))).toBe(true);
  });

  it("reads the never-sell list back off the grant JAW lists", () => {
    const limitsRaw = sellLimitsFor(CAP_MAX, PRICES, [TESLA, NVIDIA]);
    const g = sellGrant(CAP_MAX, limitsRaw);
    const listed: ListedPermission = {
      permissionId: `0x${"1".repeat(64)}`,
      spender: EXECUTOR,
      start: 1,
      end: 2,
      salt: "3",
      calls: g.calls!.map((c) => ({ target: c.target, selector: c.selector! })),
      spends: g.spends!.map((s) => ({ token: s.token, allowance: s.allowance, unit: s.unit, multiplier: 1 })),
    };
    const read = readAgentGrant(listed, EXECUTOR);
    expect(read?.job).toBe("sell");
    expect(neverSellOf(read?.limitsRaw).sort()).toEqual([NVIDIA, TESLA]);
  });
});

describe("protectSteps", () => {
  it("starts on what's saved: no change, nothing to save", () => {
    expect(protectSteps(fullOn, savedChoice(fullOn), ctx)).toEqual({ steps: [], blocked: null });
    expect(savedChoice(off)).toEqual({ sellOn: false, keepMix: false, never: [] });
  });

  it("while it's off, saving switches it on: repay from cash at the executor's CAP_MAX, then selling if chosen", () => {
    expect(protectSteps(off, savedChoice(off), ctx)).toEqual({
      steps: [{ kind: "grant", job: "protect", capRaw: CAP_MAX }],
      blocked: null,
    });
    const { steps } = protectSteps(off, { ...savedChoice(off), sellOn: true, never: [TESLA] }, ctx);
    expect(steps).toEqual([
      { kind: "grant", job: "protect", capRaw: CAP_MAX },
      { kind: "grant", job: "sell", capRaw: CAP_MAX, limitsRaw: sellLimitsFor(CAP_MAX, PRICES, [TESLA]) },
    ]);
    // A sheet per grant, then one batch that registers both (Adrian, 2026-10-20: "Batch those into one").
    expect(stepCount(steps, 0)).toBe(3);
    // Selling still on from before, its repay grant ended: repaying goes back on first.
    const sellOnly: ProtectSaved = { ...fullOn, repayOn: false };
    expect(protectSteps(sellOnly, savedChoice(sellOnly), ctx).steps).toEqual([
      { kind: "grant", job: "protect", capRaw: CAP_MAX },
    ]);
  });

  it("has no limit to change: with Protect on and nothing else changed, there's nothing to save", () => {
    const saved: ProtectSaved = { ...fullOn, sell: null };
    expect(protectSteps(saved, savedChoice(saved), ctx).steps).toEqual([]);
    expect(Object.keys(savedChoice(fullOn))).not.toContain("limitUsd");
  });

  it("switching selling on is its own grant, at the executor's CAP_MAX, leaving the never-sell stocks out", () => {
    const saved: ProtectSaved = { ...fullOn, sell: null };
    const { steps } = protectSteps(saved, { ...savedChoice(saved), sellOn: true, never: [TESLA] }, ctx);
    expect(steps).toEqual([
      { kind: "grant", job: "sell", capRaw: CAP_MAX, limitsRaw: sellLimitsFor(CAP_MAX, PRICES, [TESLA]) },
    ]);
  });

  it("switching selling off revokes it, one JAW sheet for each grant JAW lists", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), sellOn: false }, ctx);
    expect(steps).toEqual([{ kind: "revoke", job: "sell" }]);
    expect(stepCount(steps, 2)).toBe(2);
  });

  it("a changed never-sell list is a new sell grant; the same set in another order is not", () => {
    const saved: ProtectSaved = { ...fullOn, sell: { limitsRaw: sellLimitsFor(CAP_MAX, PRICES, [TESLA, NVIDIA]) } };
    expect(protectSteps(saved, { ...savedChoice(saved), never: [NVIDIA, TESLA] }, ctx).steps).toEqual([]);
    const { steps } = protectSteps(saved, { ...savedChoice(saved), never: [NVIDIA] }, ctx);
    expect(steps).toEqual([
      { kind: "grant", job: "sell", capRaw: CAP_MAX, limitsRaw: sellLimitsFor(CAP_MAX, PRICES, [NVIDIA]) },
    ]);
    expect(steps[0].kind === "grant" && steps[0].job === "sell" && steps[0].limitsRaw[TESLA]).toBeGreaterThan(0n);
  });

  it("'Sells first' goes first, and only while selling stays on", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), keepMix: true, never: [TESLA] }, ctx);
    expect(steps.map((s) => s.kind)).toEqual(["keepMix", "grant"]);
    expect(steps[0]).toEqual({ kind: "keepMix", on: true });
    expect(protectSteps(fullOn, { ...savedChoice(fullOn), keepMix: true, sellOn: false }, ctx).steps).toEqual([
      { kind: "revoke", job: "sell" },
    ]);
    // Unread registry: nothing to compare with, so no setting is sent.
    expect(protectSteps({ ...fullOn, keepMix: null }, { ...savedChoice(fullOn), keepMix: true }, ctx).steps).toEqual(
      [],
    );
  });

  it("blocks a never-sell list with every stock on it", () => {
    const all = EQUITIES.map((e) => e.reserveId);
    expect(protectSteps(fullOn, { ...savedChoice(fullOn), never: all }, ctx)).toEqual({
      steps: [],
      blocked: "Leave at least one stock Protect may sell.",
    });
  });

  it("grants at whatever CAP_MAX the executor has: $5 on a capped test deploy, the largest a grant holds without", () => {
    const test = { capMaxRaw: usdc(5), pricesRaw: PRICES };
    expect(protectSteps(off, savedChoice(off), test).steps).toEqual([
      { kind: "grant", job: "protect", capRaw: usdc(5) },
    ]);
    // No amount limit on the deploy: each stock's limit is what the grant's terms hold (32 bits of 1e-4 share).
    const none = { capMaxRaw: 2n ** 160n - 1n, pricesRaw: PRICES };
    const { steps } = protectSteps(off, { ...savedChoice(off), sellOn: true }, none);
    const sell = steps[1];
    if (sell.kind !== "grant" || sell.job !== "sell") throw new Error("no sell grant");
    expect(sell.limitsRaw).toEqual(EQUITIES.map(() => (2n ** 32n - 1n) * 10_000n));
    expect(sellGrant(sell.capRaw, sell.limitsRaw).spends).toHaveLength(2 + EQUITIES.length);
  });
});

describe('withRegistration: a save\'s grants, then one batch (Adrian, 2026-10-20: "Batch those into one")', () => {
  const grantP = { kind: "grant" as const, job: "protect" as const, capRaw: CAP_MAX };
  const grantS = {
    kind: "grant" as const,
    job: "sell" as const,
    capRaw: CAP_MAX,
    limitsRaw: sellLimitsFor(CAP_MAX, PRICES, []),
  };

  it("moves Sells first into the batch that registers what the save granted", () => {
    expect(withRegistration([{ kind: "keepMix", on: true }, grantP, grantS])).toEqual([
      grantP,
      grantS,
      { kind: "register", jobs: ["protect", "sell"], keepMix: true },
    ]);
    expect(stepCount([{ kind: "keepMix", on: true }, grantP, grantS], 0)).toBe(3);
  });

  it("leaves a save with nothing to register as it was: Sells first on its own, then the revoke", () => {
    const steps = [
      { kind: "keepMix" as const, on: false },
      { kind: "revoke" as const, job: "sell" as const },
    ];
    expect(withRegistration(steps)).toEqual(steps);
    expect(stepCount(steps, 2)).toBe(3);
  });

  it("registers a job still waiting from a save that stopped, but never one the save revokes", () => {
    expect(withRegistration([{ kind: "keepMix", on: true }], ["protect"])).toEqual([
      { kind: "register", jobs: ["protect"], keepMix: true },
    ]);
    expect(withRegistration([{ kind: "revoke", job: "sell" }], ["sell"])).toEqual([{ kind: "revoke", job: "sell" }]);
    expect(withRegistration([{ kind: "revoke", job: "sell" }], ["protect", "sell"])).toEqual([
      { kind: "revoke", job: "sell" },
      { kind: "register", jobs: ["protect"] },
    ]);
  });
});

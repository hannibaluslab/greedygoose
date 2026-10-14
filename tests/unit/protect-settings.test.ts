import { describe, expect, it } from "vitest";
import { isAddressEqual, type Address } from "viem";
import {
  neverSellOf,
  protectSteps,
  savedChoice,
  sellLimitsFor,
  stepCount,
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

const off: ProtectSaved = { repayCapRaw: null, sell: null, keepMix: false };
const sellAll = (cap: number) => ({ capRaw: usdc(cap), limitsRaw: sellLimitsFor(usdc(cap), CAP_MAX, PRICES, []) });
const fullOn: ProtectSaved = { repayCapRaw: usdc(300), sell: sellAll(300), keepMix: false };

describe("Protect's never-sell grant", () => {
  it("leaves the never-sell stocks out of the sell grant: no approve, no limit", () => {
    const limitsRaw = sellLimitsFor(usdc(300), CAP_MAX, PRICES, [TESLA]);
    expect(limitsRaw[TESLA]).toBe(0n);
    expect(limitsRaw.filter((l) => l > 0n)).toHaveLength(EQUITIES.length - 1);
    expect(limitsRaw).toEqual(stockLimitsRaw(usdc(300), CAP_MAX, PRICES, EQUITIES.map((e) => e.reserveId !== TESLA)));

    const grant = sellGrant(usdc(300), limitsRaw);
    const tesla = EQUITIES[TESLA].address;
    expect(grant.calls!.some((c) => isAddressEqual(c.target, tesla))).toBe(false);
    expect(grant.spends!.some((s) => isAddressEqual(s.token, tesla))).toBe(false);
    expect(grant.calls!.some((c) => isAddressEqual(c.target, EQUITIES[NVIDIA].address))).toBe(true);
  });

  it("reads the never-sell list back off the grant JAW lists", () => {
    const limitsRaw = sellLimitsFor(usdc(300), CAP_MAX, PRICES, [TESLA, NVIDIA]);
    const g = sellGrant(usdc(300), limitsRaw);
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
    expect(savedChoice(off)).toEqual({ limitUsd: 100, sellOn: false, keepMix: false, never: [] });
  });

  it("while it's off, saving switches it on: repay from cash at the limit on screen, then selling if chosen", () => {
    expect(protectSteps(off, savedChoice(off), ctx)).toEqual({ steps: [{ kind: "grant", job: "protect", capRaw: usdc(100) }], blocked: null });
    const { steps } = protectSteps(off, { ...savedChoice(off), limitUsd: 500, sellOn: true, never: [TESLA] }, ctx);
    expect(steps).toEqual([
      { kind: "grant", job: "protect", capRaw: usdc(500) },
      { kind: "grant", job: "sell", capRaw: usdc(500), limitsRaw: sellLimitsFor(usdc(500), CAP_MAX, PRICES, [TESLA]) },
    ]);
    expect(stepCount(steps, 0)).toBe(2);
    // Selling still on from before, its repay grant ended: repaying goes back on first, at selling's limit.
    const sellOnly: ProtectSaved = { ...fullOn, repayCapRaw: null };
    expect(protectSteps(sellOnly, savedChoice(sellOnly), ctx).steps).toEqual([{ kind: "grant", job: "protect", capRaw: usdc(300) }]);
  });

  it("a new limit with selling off is one grant (repay from cash)", () => {
    const saved: ProtectSaved = { ...fullOn, sell: null };
    const { steps } = protectSteps(saved, { ...savedChoice(saved), limitUsd: 500 }, ctx);
    expect(steps).toEqual([{ kind: "grant", job: "protect", capRaw: usdc(500) }]);
    expect(stepCount(steps, 0)).toBe(1);
  });

  it("a new limit with selling on re-grants both parts", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), limitUsd: 100 }, ctx);
    expect(steps.map((s) => `${s.kind}:${"job" in s ? s.job : ""}`)).toEqual(["grant:protect", "grant:sell"]);
    expect(steps[1]).toMatchObject({ capRaw: usdc(100), limitsRaw: sellLimitsFor(usdc(100), CAP_MAX, PRICES, []) });
    expect(stepCount(steps, 1)).toBe(2);
  });

  it("switching selling on is its own grant, at Protect's limit, leaving the never-sell stocks out", () => {
    const saved: ProtectSaved = { ...fullOn, sell: null };
    const { steps } = protectSteps(saved, { ...savedChoice(saved), sellOn: true, never: [TESLA] }, ctx);
    expect(steps).toEqual([{ kind: "grant", job: "sell", capRaw: usdc(300), limitsRaw: sellLimitsFor(usdc(300), CAP_MAX, PRICES, [TESLA]) }]);
  });

  it("switching selling off revokes it, one JAW sheet for each grant JAW lists", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), sellOn: false }, ctx);
    expect(steps).toEqual([{ kind: "revoke", job: "sell" }]);
    expect(stepCount(steps, 2)).toBe(2);
  });

  it("a changed never-sell list is a new sell grant; the same set in another order is not", () => {
    const saved: ProtectSaved = { ...fullOn, sell: { capRaw: usdc(300), limitsRaw: sellLimitsFor(usdc(300), CAP_MAX, PRICES, [TESLA, NVIDIA]) } };
    expect(protectSteps(saved, { ...savedChoice(saved), never: [NVIDIA, TESLA] }, ctx).steps).toEqual([]);
    const { steps } = protectSteps(saved, { ...savedChoice(saved), never: [NVIDIA] }, ctx);
    expect(steps).toEqual([{ kind: "grant", job: "sell", capRaw: usdc(300), limitsRaw: sellLimitsFor(usdc(300), CAP_MAX, PRICES, [NVIDIA]) }]);
    expect(steps[0].kind === "grant" && steps[0].job === "sell" && steps[0].limitsRaw[TESLA]).toBeGreaterThan(0n);
  });

  it("'Sells first' goes first, and only while selling stays on", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), keepMix: true, never: [TESLA] }, ctx);
    expect(steps.map((s) => s.kind)).toEqual(["keepMix", "grant"]);
    expect(steps[0]).toEqual({ kind: "keepMix", on: true });
    expect(protectSteps(fullOn, { ...savedChoice(fullOn), keepMix: true, sellOn: false }, ctx).steps).toEqual([{ kind: "revoke", job: "sell" }]);
    // Unread registry: nothing to compare with, so no setting is sent.
    expect(protectSteps({ ...fullOn, keepMix: null }, { ...savedChoice(fullOn), keepMix: true }, ctx).steps).toEqual([]);
  });

  it("blocks a never-sell list with every stock on it", () => {
    const all = EQUITIES.map((e) => e.reserveId);
    expect(protectSteps(fullOn, { ...savedChoice(fullOn), never: all }, ctx)).toEqual({
      steps: [],
      blocked: "Leave at least one stock Protect may sell.",
    });
  });

  it("holds a limit to the executor's CAP_MAX, so a capped test deploy sees no change", () => {
    const capMax = usdc(5);
    const saved: ProtectSaved = { repayCapRaw: usdc(5), sell: null, keepMix: false };
    expect(protectSteps(saved, { ...savedChoice(saved), limitUsd: 500 }, { capMaxRaw: capMax, pricesRaw: PRICES }).steps).toEqual([]);
  });
});

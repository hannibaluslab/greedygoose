import { describe, expect, it } from "vitest";
import { isAddressEqual, type Address } from "viem";
import {
  neverSellOf,
  protectAllows,
  protectBatch,
  protectSteps,
  savedChoice,
  sellLimitsFor,
  type ProtectSaved,
} from "@/lib/agents/protect";
import { NO_LIMIT, readAgentGrant, sellGrant, stockLimitsRaw, type ListedPermission } from "@/lib/agents/permissions";
import { EQUITIES } from "@/lib/tokens/registry";

const TESLA = 6;
const NVIDIA = 5;
const GUARD = "0x00000000000000000000000000000000000e5ec0" as Address;

const off: ProtectSaved = { repayOn: false, sell: null, keepMix: false };
const sellAll = { limitsRaw: sellLimitsFor([]) };
const fullOn: ProtectSaved = { repayOn: true, sell: sellAll, keepMix: false };

describe("Protector's never-sell grant", () => {
  it("leaves the never-sell stocks out of the sell grant: no approve, no limit", () => {
    const limitsRaw = sellLimitsFor([TESLA]);
    expect(limitsRaw[TESLA]).toBe(0n);
    expect(limitsRaw.filter((l) => l === NO_LIMIT)).toHaveLength(EQUITIES.length - 1);
    expect(limitsRaw).toEqual(stockLimitsRaw(EQUITIES.map((e) => e.reserveId !== TESLA)));

    const grant = sellGrant(limitsRaw);
    const tesla = EQUITIES[TESLA].address;
    expect(grant.calls!.some((c) => isAddressEqual(c.target, tesla))).toBe(false);
    expect(grant.spends!.some((s) => isAddressEqual(s.token, tesla))).toBe(false);
    expect(grant.calls!.some((c) => isAddressEqual(c.target, EQUITIES[NVIDIA].address))).toBe(true);
  });

  it("reads the never-sell list back off the grant JAW lists", () => {
    const limitsRaw = sellLimitsFor([TESLA, NVIDIA]);
    const g = sellGrant(limitsRaw);
    const listed: ListedPermission = {
      permissionId: `0x${"1".repeat(64)}`,
      spender: GUARD,
      start: 1,
      end: 2,
      salt: "3",
      calls: g.calls!.map((c) => ({ target: c.target, selector: c.selector! })),
      spends: g.spends!.map((s) => ({ token: s.token, allowance: s.allowance, unit: s.unit, multiplier: 1 })),
    };
    const read = readAgentGrant(listed, GUARD);
    expect(read?.job).toBe("sell");
    expect(neverSellOf(read?.limitsRaw).sort()).toEqual([NVIDIA, TESLA]);
  });
});

describe("protectSteps", () => {
  it("starts on what's saved: no change, nothing to save", () => {
    expect(protectSteps(fullOn, savedChoice(fullOn))).toEqual({ steps: [], blocked: null });
    expect(savedChoice(off)).toEqual({ sellOn: false, keepMix: false, never: [] });
  });

  it("while it's off, saving switches it on: repay from cash, then selling if chosen, neither with a limit", () => {
    expect(protectSteps(off, savedChoice(off))).toEqual({
      steps: [{ kind: "grant", job: "protect" }],
      blocked: null,
    });
    const { steps } = protectSteps(off, { ...savedChoice(off), sellOn: true, never: [TESLA] });
    expect(steps).toEqual([
      { kind: "grant", job: "protect" },
      { kind: "grant", job: "sell", limitsRaw: sellLimitsFor([TESLA]) },
    ]);
    // Both grants in one batch, one Face ID (Adrian, 2026-10-20).
    expect(protectBatch(steps)?.grants.map((g) => g.job)).toEqual(["protect", "sell"]);
    // Selling still on from before, its repay grant ended: repaying goes back on first.
    const sellOnly: ProtectSaved = { ...fullOn, repayOn: false };
    expect(protectSteps(sellOnly, savedChoice(sellOnly)).steps).toEqual([{ kind: "grant", job: "protect" }]);
  });

  it("has no limit to change: with Protector on and nothing else changed, there's nothing to save", () => {
    const saved: ProtectSaved = { ...fullOn, sell: null };
    expect(protectSteps(saved, savedChoice(saved)).steps).toEqual([]);
    expect(Object.keys(savedChoice(fullOn))).not.toContain("limitUsd");
  });

  it("switching selling on is its own grant, with no limit, leaving the never-sell stocks out", () => {
    const saved: ProtectSaved = { ...fullOn, sell: null };
    const { steps } = protectSteps(saved, { ...savedChoice(saved), sellOn: true, never: [TESLA] });
    expect(steps).toEqual([{ kind: "grant", job: "sell", limitsRaw: sellLimitsFor([TESLA]) }]);
  });

  it("switching selling off turns it off (revoked and unregistered), in the same one batch as everything else", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), sellOn: false });
    expect(steps).toEqual([{ kind: "revoke", job: "sell" }]);
    expect(protectBatch(steps)).toEqual({ grants: [], off: ["sell"] });
  });

  it("a changed never-sell list is a new sell grant; the same set in another order is not", () => {
    const saved: ProtectSaved = { ...fullOn, sell: { limitsRaw: sellLimitsFor([TESLA, NVIDIA]) } };
    expect(protectSteps(saved, { ...savedChoice(saved), never: [NVIDIA, TESLA] }).steps).toEqual([]);
    const { steps } = protectSteps(saved, { ...savedChoice(saved), never: [NVIDIA] });
    expect(steps).toEqual([{ kind: "grant", job: "sell", limitsRaw: sellLimitsFor([NVIDIA]) }]);
    expect(steps[0].kind === "grant" && steps[0].job === "sell" && steps[0].limitsRaw[TESLA]).toBeGreaterThan(0n);
  });

  it("'Sells first' goes first, and only while selling stays on", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), keepMix: true, never: [TESLA] });
    expect(steps.map((s) => s.kind)).toEqual(["keepMix", "grant"]);
    expect(steps[0]).toEqual({ kind: "keepMix", on: true });
    expect(protectSteps(fullOn, { ...savedChoice(fullOn), keepMix: true, sellOn: false }).steps).toEqual([
      { kind: "revoke", job: "sell" },
    ]);
    // Unread registry: nothing to compare with, so no setting is sent.
    expect(protectSteps({ ...fullOn, keepMix: null }, { ...savedChoice(fullOn), keepMix: true }).steps).toEqual([]);
  });

  it("blocks a never-sell list with every stock on it", () => {
    const all = EQUITIES.map((e) => e.reserveId);
    expect(protectSteps(fullOn, { ...savedChoice(fullOn), never: all })).toEqual({
      steps: [],
      blocked: "Leave at least one stock Protector may sell.",
    });
  });

  it("grants with no limit anywhere (decision 9): every stock it may sell at the largest a JAW spend holds", () => {
    const { steps } = protectSteps(off, { ...savedChoice(off), sellOn: true });
    const sell = steps[1];
    if (sell.kind !== "grant" || sell.job !== "sell") throw new Error("no sell grant");
    expect(sell.limitsRaw).toEqual(EQUITIES.map(() => NO_LIMIT));
    expect(sellGrant(sell.limitsRaw).spends).toHaveLength(2 + EQUITIES.length);
  });
});

describe('protectBatch: a save in one batch, one Face ID (Adrian, 2026-10-20: "in one signature")', () => {
  const grantP = { kind: "grant" as const, job: "protect" as const };
  const grantS = { kind: "grant" as const, job: "sell" as const, limitsRaw: sellLimitsFor([]) };

  it("carries every grant, selling's revoke and Sells first together; nothing to save is no batch", () => {
    expect(protectBatch([{ kind: "keepMix", on: true }, grantP, grantS])).toEqual({
      grants: [{ job: "protect" }, { job: "sell", limitsRaw: grantS.limitsRaw }],
      off: [],
      keepMix: true,
    });
    expect(
      protectBatch([
        { kind: "keepMix", on: false },
        { kind: "revoke", job: "sell" },
      ]),
    ).toEqual({
      grants: [],
      off: ["sell"],
      keepMix: false,
    });
    expect(protectBatch([])).toBeNull();
  });

  it("says what the Face ID lets Protector do when it grants, never the machinery, and nothing when it doesn't", () => {
    expect(protectAllows([grantP], "1.03", null)).toBe(
      "Protector can repay from your cash if your credit falls under 1.03, for a year. You can turn it off here.",
    );
    expect(protectAllows([grantP, grantS], "1.03", "Tesla")).toBe(
      "Protector can repay from your cash if your credit falls under 1.03, for a year. If cash isn’t enough, it can also sell stock that backs your credit, never Tesla. You can turn it off here.",
    );
    // Selling's grant alone: repaying keeps its own grant and end, so the line says only what this Face ID allows.
    expect(protectAllows([grantS], "1.03", null)).toBe(
      "If cash isn’t enough, Protector can also sell stock that backs your credit, for a year. You can turn it off here.",
    );
    expect(protectAllows([{ kind: "revoke", job: "sell" }], "1.03", null)).toBeNull();
    expect(protectAllows([grantP, grantS], "1.03", null)).not.toMatch(/borrow|lock|permission|grant|executor/i);
  });
});

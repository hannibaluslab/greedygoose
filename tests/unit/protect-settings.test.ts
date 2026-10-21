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

describe("Protector's never-sell grant", () => {
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
    // Both grants in one batch, one Face ID (Adrian, 2026-10-20).
    expect(protectBatch(steps)?.grants.map((g) => g.job)).toEqual(["protect", "sell"]);
    // Selling still on from before, its repay grant ended: repaying goes back on first.
    const sellOnly: ProtectSaved = { ...fullOn, repayOn: false };
    expect(protectSteps(sellOnly, savedChoice(sellOnly), ctx).steps).toEqual([
      { kind: "grant", job: "protect", capRaw: CAP_MAX },
    ]);
  });

  it("has no limit to change: with Protector on and nothing else changed, there's nothing to save", () => {
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

  it("switching selling off revokes it, in the same one batch as everything else", () => {
    const { steps } = protectSteps(fullOn, { ...savedChoice(fullOn), sellOn: false }, ctx);
    expect(steps).toEqual([{ kind: "revoke", job: "sell" }]);
    expect(protectBatch(steps)).toEqual({ grants: [], off: ["sell"] });
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
      blocked: "Leave at least one stock Protector may sell.",
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

describe('protectBatch: a save in one batch, one Face ID (Adrian, 2026-10-20: "in one signature")', () => {
  const grantP = { kind: "grant" as const, job: "protect" as const, capRaw: CAP_MAX };
  const grantS = {
    kind: "grant" as const,
    job: "sell" as const,
    capRaw: CAP_MAX,
    limitsRaw: sellLimitsFor(CAP_MAX, PRICES, []),
  };

  it("carries every grant, selling's revoke and Sells first together; nothing to save is no batch", () => {
    expect(protectBatch([{ kind: "keepMix", on: true }, grantP, grantS])).toEqual({
      grants: [
        { job: "protect", capRaw: CAP_MAX },
        { job: "sell", capRaw: CAP_MAX, limitsRaw: grantS.limitsRaw },
      ],
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

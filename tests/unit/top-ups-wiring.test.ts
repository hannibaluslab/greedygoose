import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, isAddressEqual, toFunctionSelector, type Hex } from "viem";

// The app's Guard, before anything reads lib/agents/config.ts: the allowlist only lets it through once it's set.
const GUARD = vi.hoisted(() => {
  const guard = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_GUARD = guard;
  return guard;
});

import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { agentJobOf } from "@/lib/agents/agentJob";
import { approveCall, contractPermission, jawPermission, oneTapGrantCalls } from "@/lib/agents/oneTapGrant";
import { GRANT_SECONDS, jobGrant, stockLimitsRaw } from "@/lib/agents/permissions";
import { rebalanceChange, type MixSave } from "@/lib/agents/rebalanceSettings";
import { buildRegisterCalls, buildUnregisterCalls } from "@/lib/agents/register";
import { buildSetMixCalls, buildSetTopUpsCalls } from "@/lib/agents/settings";
import { KEEP_MAX_RAW, chainFacts, keepRawOf } from "@/lib/agents/topUps";
import { assertAllowed } from "@/lib/allowlist";
import { PROTOCOLS } from "@/lib/protocols/config";
import { startEarningPlan, startEarningPrefix } from "@/lib/startEarning";
import { EQUITIES } from "@/lib/tokens/registry";
import { agentChangePlan, revokeCall } from "@/lib/tx/plans";

const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const stranger = "0x00000000000000000000000000000000000a11ce" as const;
const NOW = Math.floor(Date.now() / 1000);
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const setTopUps = (on: boolean, keep: number) =>
  encodeFunctionData({ abi: guardAbi, functionName: "setTopUps", args: [on, keep] });
const send = (data: `0x${string}`, to: `0x${string}` = GUARD, value = 0n) => assertAllowed(user, [{ to, data, value }]);
const fnOf = (data: `0x${string}`) => decodeFunctionData({ abi: guardAbi, data });
const deps = { getCode: () => Promise.resolve("0x6001" as Hex), ownerCalls: () => Promise.resolve([]) };

/** The Rebalancer's grant for a NVIDIA/Apple mix, as a change builds it. */
const limits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "NVDAc" || e.symbol === "AAPLc"));
const rebalanceOf = (salt = 7n) =>
  jawPermission(user, GUARD, NOW - 300 + GRANT_SECONDS, jobGrant("rebalance", limits), { start: NOW - 300, salt });

describe("setTopUps (Top-ups go into my mix, with Keep as cash)", () => {
  it("is the Guard's setTopUps(bool, uint48), Keep in USDC units, and nothing else", () => {
    const [call] = buildSetTopUpsCalls(user, true, usdc(500));
    expect(call.to).toBe(GUARD);
    expect(call.value).toBe(0n);
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector("setTopUps(bool,uint48)"));
    expect(fnOf(call.data)).toMatchObject({ functionName: "setTopUps", args: [true, 500_000_000] });
    expect(call.data).toBe(setTopUps(true, 500_000_000));
    expect(buildSetTopUpsCalls(user, false, 0n)[0].data).toBe(setTopUps(false, 0));
  });

  it("takes Keep from $0 to $1,000,000 in whole dollars", () => {
    expect(keepRawOf(500)).toBe(usdc(500));
    expect(keepRawOf(0)).toBe(0n);
    expect(KEEP_MAX_RAW).toBe(10n ** 12n);
    expect(buildSetTopUpsCalls(user, true, KEEP_MAX_RAW)).toHaveLength(1);
    expect(() => buildSetTopUpsCalls(user, true, KEEP_MAX_RAW + 1n)).toThrow(/Keep as cash/);
    expect(() => buildSetTopUpsCalls(user, true, -1n)).toThrow(/Keep as cash/);
  });

  it("turning off is never refused over a Keep set past $1,000,000 outside the app (the Guard takes any uint48)", () => {
    const onChain = 2n ** 48n - 1n;
    expect(buildSetTopUpsCalls(user, false, onChain)[0].data).toBe(setTopUps(false, 10 ** 12));
    expect(buildSetTopUpsCalls(user, false, usdc(500))[0].data).toBe(setTopUps(false, 500_000_000));
    expect(() => buildSetTopUpsCalls(user, true, onChain)).toThrow(/Keep as cash/);
    const off = rebalanceChange(
      user,
      {
        weights: [5_000, 0, 0, 0, 0, 5_000, 0],
        mixChanged: false,
        grant: null,
        topUps: { on: false, keepUsd: 2_000_000 },
        topUpsChanged: true,
        topUpsTurningOn: false,
      },
      { save: "on" },
    )!;
    expect(off.settings.map((c) => c.data)).toEqual([setTopUps(false, 10 ** 12)]);
  });

  it("the allowlist takes it on the Guard alone, with no value and Keep at most $1,000,000", () => {
    expect(send(setTopUps(true, 10 ** 12))).toHaveLength(1);
    expect(send(setTopUps(false, 0))).toHaveLength(1);
    expect(() => send(setTopUps(true, 10 ** 12 + 1))).toThrow(/Blocked: unexpected arguments to setTopUps/);
    expect(() => send(setTopUps(true, 500_000_000), stranger)).toThrow(/Blocked: unexpected target/);
    expect(() => send(setTopUps(true, 500_000_000), GUARD, 1n)).toThrow(/Blocked: unexpected value/);
  });
});

describe("a top-ups change in one batch", () => {
  it("Keep alone, or the switch alone, is a settings-only batch: no approve, nothing to register", () => {
    expect(buildRegisterCalls(user, [], buildSetTopUpsCalls(user, true, usdc(800))).map((c) => c.data)).toEqual([
      setTopUps(true, 800_000_000),
    ]);
  });

  it("turning Rebalance off revokes its grant, switches top-ups off and unregisters it, in one batch", async () => {
    const settings = [...buildSetTopUpsCalls(user, false, usdc(500)), ...buildUnregisterCalls(user, ["rebalance"])];
    const plan = agentChangePlan(user, { grants: [], revokes: [contractPermission(rebalanceOf())], settings }, deps);
    const calls = await (plan.calls as () => Promise<unknown[]>)();
    expect(calls).toEqual([revokeCall(contractPermission(rebalanceOf())), ...settings]);
  });

  it("turning top-ups on saves the wallet's cash first, then the grants, the mix and the switch, each registered", async () => {
    const save = jawPermission(user, GUARD, NOW - 300 + GRANT_SECONDS, jobGrant("save"), {
      start: NOW - 300,
      salt: 8n,
    });
    const rebalance = rebalanceOf();
    const settings = [
      ...buildSetMixCalls(user, [5_000, 0, 0, 0, 0, 5_000, 0]),
      ...buildSetTopUpsCalls(user, true, usdc(500)),
    ];
    const supply = startEarningPlan(user, usdc(120), () => Promise.resolve(usdc(120)))!;
    const plan = agentChangePlan(
      user,
      { grants: [rebalance, save], settings, prefix: startEarningPrefix(supply) },
      deps,
    );
    const calls = await (plan.calls as () => Promise<{ to: `0x${string}`; data: Hex }[]>)();
    const names = calls.map((c) =>
      isAddressEqual(c.to, GUARD)
        ? fnOf(c.data).functionName
        : isAddressEqual(c.to, PROTOCOLS.AAVE_V3_POOL)
          ? "supply"
          : isAddressEqual(c.to, PROTOCOLS.PERMISSION_MANAGER)
            ? "approve grant"
            : "approve",
    );
    expect(names).toEqual([
      "approve",
      "supply",
      "approve grant",
      "approve grant",
      "setMix",
      "setTopUps",
      "register",
      "register",
    ]);
    expect(agentJobOf(contractPermission(rebalance), user, GUARD)).toBe("rebalance");
    // A grant approved and left unregistered is refused, as any grant is.
    expect(() => assertAllowed(user, [approveCall(rebalance), ...settings])).toThrow(/same batch/);
    expect(oneTapGrantCalls(user, [rebalance], [], settings)).toHaveLength(4);
  });
});

describe("rebalanceChange (what Rebalance's Save puts in its batch)", () => {
  const grant = { job: "rebalance" as const, limitsRaw: limits };
  const base: MixSave = {
    weights: [5_000, 0, 0, 0, 0, 5_000, 0],
    mixChanged: false,
    grant: null,
    topUps: { on: true, keepUsd: 500 },
    topUpsChanged: false,
    topUpsTurningOn: false,
  };
  const on = { save: "on" as const };

  it("is nothing when nothing changed", () => {
    expect(rebalanceChange(user, base, on)).toBeNull();
  });

  it("saves Keep alone as settings, no grant", () => {
    const c = rebalanceChange(user, { ...base, topUps: { on: true, keepUsd: 800 }, topUpsChanged: true }, on)!;
    expect(c.grants).toEqual([]);
    expect(c.settings.map((x) => fnOf(x.data))).toEqual([{ functionName: "setTopUps", args: [true, 800_000_000] }]);
  });

  it("turns top-ups on with the switch alone, and earning's grant too while it's off (P3, one signature)", () => {
    const p = { ...base, topUpsChanged: true, topUpsTurningOn: true };
    const c = rebalanceChange(user, p, { save: "off" })!;
    expect(c.grants).toEqual([{ job: "save" }]);
    expect(c.settings.map((x) => fnOf(x.data).functionName)).toEqual(["setTopUps"]);
    // Earning already on: the switch alone, no Rebalancer grant.
    expect(rebalanceChange(user, p, on)!.grants).toEqual([]);
    // While earning's state loads, it waits rather than leave Keep with nothing to fill it.
    expect(rebalanceChange(user, p, { save: "loading" })).toBeNull();
  });

  it("grants the Rebalancer only when the mix needs it, whatever top-ups do", () => {
    const p = { ...base, mixChanged: true, grant, topUpsChanged: true, topUpsTurningOn: true };
    expect(rebalanceChange(user, p, { save: "off" })!.grants).toEqual([grant, { job: "save" }]);
    expect(rebalanceChange(user, { ...base, grant }, on)!.grants).toEqual([grant]);
  });

  it("turns them off with the setting alone: no grant, earning untouched", () => {
    const p = { ...base, topUps: { on: false, keepUsd: 500 }, topUpsChanged: true };
    const c = rebalanceChange(user, p, { save: "off" })!;
    expect(c.grants).toEqual([]);
    expect(c.settings.map((x) => fnOf(x.data))).toEqual([{ functionName: "setTopUps", args: [false, 500_000_000] }]);
  });

  it("puts the mix first, then top-ups, in the same batch", () => {
    const p = { ...base, mixChanged: true, topUps: { on: true, keepUsd: 0 }, topUpsChanged: true };
    const c = rebalanceChange(user, p, on)!;
    expect(c.settings.map((x) => fnOf(x.data).functionName)).toEqual(["setMix", "setTopUps"]);
  });

  it("sends no setTopUps while the Guard's setting isn't read", () => {
    const c = rebalanceChange(user, { ...base, mixChanged: true, topUps: null, topUpsChanged: false }, on)!;
    expect(c.settings.map((x) => fnOf(x.data).functionName)).toEqual(["setMix"]);
  });
});

describe("chainFacts (top-ups as the card reads them from Base)", () => {
  it("with no Guard: not available, nothing else to say", () => {
    expect(chainFacts({ available: false, on: false, keepRaw: 0n, waitingRaw: 0n })).toEqual({
      available: false,
      earningFirst: false,
      saved: null,
      waiting: null,
    });
  });

  it("on, with $300 in the wallet the Planner would put in at the next round", () => {
    expect(chainFacts({ available: true, on: true, keepRaw: usdc(500), waitingRaw: usdc(300) })).toEqual({
      available: true,
      earningFirst: false,
      saved: { on: true, keepUsd: 500 },
      waiting: { usd: 300 },
    });
  });

  it("nothing waits while the switch is off; before the read the switch waits with nothing to say", () => {
    expect(chainFacts({ available: true, on: false, keepRaw: usdc(500), waitingRaw: usdc(300) }).waiting).toBeNull();
    expect(chainFacts(null)).toEqual({ available: true, earningFirst: false, saved: null, waiting: null });
  });
});

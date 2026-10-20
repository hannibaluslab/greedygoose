import { describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  decodeFunctionData,
  encodeFunctionData,
  maxUint160,
  toFunctionSelector,
  type Hex,
} from "viem";

// The app's executor, before anything reads lib/agents/config.ts: the allowlist only lets it through once it's set.
const EXECUTOR = vi.hoisted(() => {
  const executor = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_EXECUTOR = executor;
  return executor;
});

import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { agentJobOf } from "@/lib/agents/agentJob";
import { nyDay } from "@/lib/agents/next";
import { approveCall, contractPermission, jawPermission, oneTapGrantCalls } from "@/lib/agents/oneTapGrant";
import { GRANT_SECONDS, jobGrant, startCapRaw, stockLimitsRaw } from "@/lib/agents/permissions";
import { rebalanceChange, type MixSave } from "@/lib/agents/rebalanceSettings";
import { buildRegisterCalls } from "@/lib/agents/register";
import { buildSetMixCalls, buildSetTopUpsCalls } from "@/lib/agents/settings";
import {
  KEEP_MAX_RAW,
  chainFacts,
  keepRawOf,
  readTopUps,
  topUpsAnswerOf,
  topUpsReverted,
  type TopUpsAnswer,
} from "@/lib/agents/topUps";
import { assertAllowed } from "@/lib/allowlist";
import { EQUITIES } from "@/lib/tokens/registry";
import { agentChangePlan, revokeCall } from "@/lib/tx/plans";

const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const stranger = "0x00000000000000000000000000000000000a11ce" as const;
const NOW = Math.floor(Date.now() / 1000);
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const setTopUps = (on: boolean, keep: number) =>
  encodeFunctionData({ abi: gooseExecutorAbi, functionName: "setTopUps", args: [on, keep] });
const send = (data: `0x${string}`, to: `0x${string}` = EXECUTOR, value = 0n) =>
  assertAllowed(user, [{ to, data, value }]);

/** The Rebalancer's grant at CAP_MAX for a NVIDIA/Apple mix, with or without top-ups, as a change builds it. */
const limits = stockLimitsRaw(
  maxUint160,
  maxUint160,
  EQUITIES.map(() => 200n * 10n ** 8n),
  EQUITIES.map((e) => e.symbol === "NVDAc" || e.symbol === "AAPLc"),
);
const rebalanceOf = (topUps: boolean, salt = 7n) =>
  jawPermission(user, EXECUTOR, NOW - 300 + GRANT_SECONDS, jobGrant("rebalance", maxUint160, limits, topUps), {
    start: NOW - 300,
    salt,
  });

describe("setTopUps (Top-ups go into my mix, with Keep as cash)", () => {
  it("is the executor's setTopUps(bool, uint48), Keep in USDC units, and nothing else", () => {
    const [call] = buildSetTopUpsCalls(user, true, usdc(500));
    expect(call.to).toBe(EXECUTOR);
    expect(call.value).toBe(0n);
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector("setTopUps(bool,uint48)"));
    expect(decodeFunctionData({ abi: gooseExecutorAbi, data: call.data })).toMatchObject({
      functionName: "setTopUps",
      args: [true, 500_000_000],
    });
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

  it("turning off is never refused over a Keep set past $1,000,000 outside the app (the executor takes any uint48)", () => {
    // Turn off Rebalance sends the executor's own Keep back (useAgents), and the sheet's switch the saved one.
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
      },
      { save: "on", capMaxRaw: maxUint160 },
    )!;
    expect(off.settings.map((c) => c.data)).toEqual([setTopUps(false, 10 ** 12)]);
  });

  it("the allowlist takes it on the executor alone, with no value and Keep at most $1,000,000", () => {
    expect(send(setTopUps(true, 10 ** 12))).toHaveLength(1);
    expect(send(setTopUps(false, 0))).toHaveLength(1);
    expect(() => send(setTopUps(true, 10 ** 12 + 1))).toThrow(/Blocked: unexpected arguments to setTopUps/);
    expect(() => send(setTopUps(true, 500_000_000), stranger)).toThrow(/Blocked: unexpected target/);
    expect(() => send(setTopUps(true, 500_000_000), EXECUTOR, 1n)).toThrow(/Blocked: unexpected value/);
  });
});

describe("a top-ups change in one batch (the allowlist's pairing)", () => {
  it("Keep alone is a settings-only batch: no approve, nothing to register", () => {
    const calls = buildRegisterCalls(user, [], buildSetTopUpsCalls(user, true, usdc(800)));
    expect(calls.map((c) => c.data)).toEqual([setTopUps(true, 800_000_000)]);
  });

  it("turning Rebalance off revokes its grant and switches top-ups off, in one batch", async () => {
    const plan = agentChangePlan(
      user,
      {
        grants: [],
        revokes: [contractPermission(rebalanceOf(true))],
        settings: buildSetTopUpsCalls(user, false, usdc(500)),
      },
      { getCode: () => Promise.resolve("0x6001" as Hex), ownerCalls: () => Promise.resolve([]) },
    );
    const calls = await (plan.calls as () => Promise<unknown[]>)();
    expect(calls).toEqual([
      revokeCall(contractPermission(rebalanceOf(true))),
      ...buildSetTopUpsCalls(user, false, usdc(500)),
    ]);
  });

  it("turning top-ups on: earning's grant and the Rebalancer's with the withdraw, the mix and the switch, each registered", () => {
    const save = jawPermission(user, EXECUTOR, NOW - 300 + GRANT_SECONDS, jobGrant("save", usdc(1_000)), {
      start: NOW - 300,
      salt: 8n,
    });
    const rebalance = rebalanceOf(true);
    const settings = [
      ...buildSetMixCalls(user, [5_000, 0, 0, 0, 0, 5_000, 0]),
      ...buildSetTopUpsCalls(user, true, usdc(500)),
    ];
    const calls = oneTapGrantCalls(user, [rebalance, save], [], settings);
    const names = calls.map((c) =>
      c.to === EXECUTOR ? decodeFunctionData({ abi: gooseExecutorAbi, data: c.data }).functionName : "approve",
    );
    expect(names).toEqual(["approve", "approve", "setMix", "setTopUps", "registerApproved", "registerApproved"]);
    expect(agentJobOf(contractPermission(rebalance), user, EXECUTOR)).toBe("rebalance");
    // The flagged grant approved and left unregistered is refused, as any grant is.
    expect(() => assertAllowed(user, [approveCall(rebalance), ...settings])).toThrow(/same batch/);
  });
});

describe("rebalanceChange (what Rebalance's Save puts in its batch)", () => {
  const grant = { job: "rebalance" as const, capRaw: maxUint160, limitsRaw: limits };
  const base: MixSave = {
    weights: [5_000, 0, 0, 0, 0, 5_000, 0],
    mixChanged: false,
    grant: null,
    topUps: { on: true, keepUsd: 500 },
    topUpsChanged: false,
  };
  const on = { save: "on" as const, capMaxRaw: maxUint160 };
  const fnOf = (data: `0x${string}`) => decodeFunctionData({ abi: gooseExecutorAbi, data });

  it("is nothing when nothing changed", () => {
    expect(rebalanceChange(user, base, on)).toBeNull();
  });

  it("saves Keep alone as settings, no grant", () => {
    const c = rebalanceChange(user, { ...base, topUps: { on: true, keepUsd: 800 }, topUpsChanged: true }, on)!;
    expect(c.grants).toEqual([]);
    expect(c.settings.map((x) => fnOf(x.data))).toEqual([{ functionName: "setTopUps", args: [true, 800_000_000] }]);
  });

  it("turns top-ups on with the flagged grant, and earning's grant too while it's off (P3, one signature)", () => {
    const p = { ...base, grant: { ...grant, topUps: true }, topUpsChanged: true };
    const c = rebalanceChange(user, p, { save: "off", capMaxRaw: maxUint160 })!;
    expect(c.grants).toEqual([
      { ...grant, topUps: true },
      { job: "save", capRaw: startCapRaw("save", maxUint160) },
    ]);
    expect(c.settings.map((x) => fnOf(x.data).functionName)).toEqual(["setTopUps"]);
    // Earning already on: the Rebalancer's grant alone.
    expect(rebalanceChange(user, p, on)!.grants).toEqual([{ ...grant, topUps: true }]);
    // While earning's state loads, it waits rather than turn top-ups on with nothing to count them.
    expect(rebalanceChange(user, p, { save: "loading", capMaxRaw: maxUint160 })).toBeNull();
    expect(rebalanceChange(user, p, { save: "off", capMaxRaw: null })).toBeNull();
  });

  it("grants earning too when the Rebalancer is granted anew with top-ups already on, never for Keep alone", () => {
    const p = { ...base, grant: { ...grant, topUps: true } };
    expect(rebalanceChange(user, p, { save: "off", capMaxRaw: maxUint160 })!.grants).toEqual([
      { ...grant, topUps: true },
      { job: "save", capRaw: startCapRaw("save", maxUint160) },
    ]);
    const keepOnly = { ...base, topUps: { on: true, keepUsd: 900 }, topUpsChanged: true };
    expect(rebalanceChange(user, keepOnly, { save: "off", capMaxRaw: maxUint160 })!.grants).toEqual([]);
  });

  it("turns them off with a grant without the withdraw, and never grants earning for it", () => {
    const p = { ...base, grant, topUps: { on: false, keepUsd: 500 }, topUpsChanged: true };
    const c = rebalanceChange(user, p, { save: "off", capMaxRaw: maxUint160 })!;
    expect(c.grants).toEqual([grant]);
    expect(c.settings.map((x) => fnOf(x.data))).toEqual([{ functionName: "setTopUps", args: [false, 500_000_000] }]);
  });

  it("turns them off alone after Rebalance stopped: the setting only, no grant, earning untouched", () => {
    const p = { ...base, topUps: { on: false, keepUsd: 500 }, topUpsChanged: true };
    const c = rebalanceChange(user, p, { save: "off", capMaxRaw: maxUint160 })!;
    expect(c.grants).toEqual([]);
    expect(c.settings.map((x) => fnOf(x.data))).toEqual([{ functionName: "setTopUps", args: [false, 500_000_000] }]);
  });

  it("puts the mix first, then top-ups, in the same batch", () => {
    const p = { ...base, mixChanged: true, topUps: { on: true, keepUsd: 0 }, topUpsChanged: true };
    const c = rebalanceChange(user, p, on)!;
    expect(c.settings.map((x) => fnOf(x.data).functionName)).toEqual(["setMix", "setTopUps"]);
  });

  it("sends no setTopUps while the executor's setting isn't read", () => {
    const c = rebalanceChange(user, { ...base, mixChanged: true, topUps: null, topUpsChanged: false }, on)!;
    expect(c.settings.map((x) => fnOf(x.data).functionName)).toEqual(["setMix"]);
  });
});

describe("readTopUps (topUps(account) on Base)", () => {
  // Tuesday 2026-10-20, 3 PM in New York (EDT, UTC-4).
  const tue3pm = Date.UTC(2026, 9, 20, 19) / 1000;
  const today = nyDay(tue3pm);
  const wed10am = Date.UTC(2026, 9, 21, 14) / 1000;
  const tue10am = Date.UTC(2026, 9, 20, 14) / 1000;
  const answer = (o: Partial<{ on: boolean; day: number; keep: number; ready: bigint; today: bigint; mark: bigint }>) =>
    ({
      status: "success",
      result: [o.on ?? true, o.day ?? today, o.keep ?? 500_000_000, o.ready ?? 0n, o.today ?? 0n, o.mark ?? 0n, 0n],
    }) as TopUpsAnswer;
  const ctx = { nowSec: tue3pm, savingsRaw: usdc(1_300), rebalanceDay: 0 };

  it("is not available on an executor without top-ups: its getter reverts", () => {
    const r = readTopUps({ status: "failure" }, ctx);
    expect(r).toEqual({ available: false, on: false, keepRaw: 0n, waitingRaw: 0n, readyAtSec: 0 });
    expect(chainFacts(r)).toEqual({ available: false, earningFirst: false, saved: null, waiting: null });
  });

  it("a $300 top-up counted at 3 PM waits for tomorrow's 10:00 check", () => {
    const r = readTopUps(answer({ today: usdc(300), mark: usdc(1_300) }), ctx);
    expect(r).toEqual({ available: true, on: true, keepRaw: usdc(500), waitingRaw: usdc(300), readyAtSec: wed10am });
    expect(chainFacts(r)).toEqual({
      available: true,
      earningFirst: false,
      saved: { on: true, keepUsd: 500 },
      waiting: { usd: 300, atSec: wed10am },
    });
  });

  it("counted yesterday, it goes in at today's check while its window is ahead, else the next market day's", () => {
    const yesterday = answer({ day: today - 1, today: usdc(300), mark: usdc(1_300) });
    const morning = { ...ctx, nowSec: tue10am - 3_600 };
    expect(readTopUps(yesterday, morning)).toMatchObject({ waitingRaw: usdc(300), readyAtSec: tue10am });
    // Rebalance already ran today (one batch a day): tomorrow.
    expect(readTopUps(yesterday, { ...morning, rebalanceDay: today })).toMatchObject({ readyAtSec: wed10am });
  });

  it("a fall in savings since the count comes out of what waits, and it never passes savings above Keep", () => {
    expect(
      readTopUps(answer({ today: usdc(300), mark: usdc(1_300) }), { ...ctx, savingsRaw: usdc(1_200) }),
    ).toMatchObject({ waitingRaw: usdc(200) });
    expect(readTopUps(answer({ ready: usdc(900), mark: usdc(1_300) }), ctx)).toMatchObject({ waitingRaw: usdc(800) });
  });

  it("only a revert is not available: Base not answering waits, and the last answer stands through a failed refetch", () => {
    const at = { abi: gooseExecutorAbi, functionName: "topUps", args: [user], contractAddress: EXECUTOR } as const;
    // What the executor live today answers (measured on Base: its getter reverts).
    const reverted = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: gooseExecutorAbi, functionName: "topUps", data: "0x" }),
      at,
    );
    // What a 429 or a dropped call looks like to the app.
    const unanswered = new ContractFunctionExecutionError(
      new HttpRequestError({ url: "https://mainnet.base.org", status: 429 }),
      at,
    );
    expect(topUpsReverted(reverted)).toBe(true);
    expect(topUpsReverted(unanswered)).toBe(false);
    expect(topUpsAnswerOf(undefined, reverted)).toEqual({ status: "failure" });
    expect(topUpsAnswerOf(undefined, unanswered)).toBeUndefined();
    expect(topUpsAnswerOf(undefined, null)).toBeUndefined();
    const read = answer({ on: true }) as Extract<TopUpsAnswer, { status: "success" }>;
    expect(topUpsAnswerOf(read.result, unanswered)).toEqual(read);
  });

  it("nothing waits while the switch is off; before the read the switch waits with nothing to say", () => {
    const off = readTopUps(answer({ on: false, today: usdc(300) }), ctx);
    expect(off).toMatchObject({ available: true, on: false, waitingRaw: 0n });
    expect(chainFacts(off).waiting).toBeNull();
    expect(chainFacts(null)).toEqual({ available: true, earningFirst: false, saved: null, waiting: null });
  });
});

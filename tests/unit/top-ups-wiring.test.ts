import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, maxUint160, toFunctionSelector } from "viem";

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
import { GRANT_SECONDS, jobGrant, stockLimitsRaw } from "@/lib/agents/permissions";
import { buildRegisterCalls } from "@/lib/agents/register";
import { buildSetMixCalls, buildSetTopUpsCalls } from "@/lib/agents/settings";
import { KEEP_MAX_RAW, chainFacts, keepRawOf, readTopUps, type TopUpsAnswer } from "@/lib/agents/topUps";
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
      { ownerCalls: () => Promise.resolve([]) },
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

  it("nothing waits while the switch is off; before the read the switch waits with nothing to say", () => {
    const off = readTopUps(answer({ on: false, today: usdc(300) }), ctx);
    expect(off).toMatchObject({ available: true, on: false, waitingRaw: 0n });
    expect(chainFacts(off).waiting).toBeNull();
    expect(chainFacts(null)).toEqual({ available: true, earningFirst: false, saved: null, waiting: null });
  });
});

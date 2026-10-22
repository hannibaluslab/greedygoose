import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, toFunctionSelector, toHex, zeroAddress } from "viem";

const GUARD = vi.hoisted(() => {
  const guard = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_GUARD = guard;
  return guard;
});

import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { packMix, unpackMix } from "@/lib/agents/mix";
import {
  agentPermission,
  entryPermission,
  grantPermission,
  jobGrant,
  JOBS,
  listedFromGrant,
  readAgentGrant,
  rebalancePermission,
  sellPermission,
  stockLimitsRaw,
  type AgentGrant,
  type AgentJob,
  type JawPermission,
} from "@/lib/agents/permissions";
import { pickFor } from "@/lib/agents/picks";
import {
  buildRegisterCalls,
  buildUnregisterCalls,
  decodePermission,
  encodePermission,
  heldStartOf,
} from "@/lib/agents/register";
import { changeSheets } from "@/lib/agents/status";
import { buildSetKeepMixCalls, buildSetMixCalls, endRescueCalls } from "@/lib/agents/settings";
import { assertAllowed } from "@/lib/allowlist";
import { registerPlan } from "@/lib/tx/plans";
import { EQUITIES } from "@/lib/tokens/registry";

const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const someoneElse = "0x00000000000000000000000000000000000a11ce" as const;
const window = { start: 1_760_000_000, end: 1_791_536_000, salt: 0xabcdefn };
// Protect may sell NVIDIA and Tesla; the Rebalancer may sell Apple.
const sellLimits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "NVDAc" || e.symbol === "TSLAc"));
const rebalanceLimits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "AAPLc"));

const grantOf = (job: AgentGrant["job"], over: Partial<AgentGrant> = {}): AgentGrant => ({
  job,
  permissionId: `0x${"ab".repeat(32)}`,
  ...window,
  ...(job === "sell" && { limitsRaw: sellLimits }),
  ...(job === "rebalance" && { limitsRaw: rebalanceLimits }),
  ...over,
});
const own = (job: AgentJob) => ({ job, p: grantPermission(grantOf(job), user, GUARD) });
const fn = (data: `0x${string}`) => decodeFunctionData({ abi: guardAbi, data });

describe("grantPermission: the permission JAW put on-chain for a grant of ours", () => {
  it("is each job's own builder, with the start, end and salt it was signed with", () => {
    const signed = { account: user, spender: GUARD, ...window };
    expect(grantPermission(grantOf("save"), user, GUARD)).toEqual(agentPermission("save", signed));
    expect(grantPermission(grantOf("protect"), user, GUARD)).toEqual(agentPermission("protect", signed));
    expect(grantPermission(grantOf("sell"), user, GUARD)).toEqual(sellPermission({ ...signed, limitsRaw: sellLimits }));
    expect(grantPermission(grantOf("rebalance"), user, GUARD)).toEqual(
      rebalancePermission({ ...signed, limitsRaw: rebalanceLimits }),
    );
    expect(grantPermission(grantOf("entry"), user, GUARD)).toEqual(entryPermission(signed));
  });

  it("needs the stocks for the jobs that sell", () => {
    expect(() => grantPermission(grantOf("sell", { limitsRaw: undefined }), user, GUARD)).toThrow(/per stock/);
  });

  it("reads JAW's grant response like its list: hex allowance and salt, no checker", () => {
    const grant = jobGrant("sell", sellLimits);
    const response = {
      account: user,
      spender: GUARD,
      start: window.start,
      end: window.end,
      salt: toHex(window.salt),
      calls: grant.calls!.map((c) => ({ target: c.target, selector: c.selector })),
      spends: grant.spends!.map((s) => ({ ...s, allowance: toHex(BigInt(s.allowance)), multiplier: 1 })),
      permissionId: `0x${"cd".repeat(32)}`,
      chainId: "0x2105",
    };
    const read = readAgentGrant(listedFromGrant(response), GUARD);
    expect(read).toEqual({ ...grantOf("sell"), permissionId: response.permissionId });
    // A response for anything else isn't one of ours, so nothing is registered for it.
    expect(readAgentGrant(listedFromGrant({ ...response, spender: someoneElse }), GUARD)).toBeNull();
  });
});

describe("the registration's bytes: abi.encode(permission), as the manager's PermissionApproved logs it", () => {
  it("round-trips every job's permission", () => {
    for (const job of JOBS) {
      const p = grantPermission(grantOf(job), user, GUARD);
      const data = encodePermission(p);
      const back = decodePermission(data);
      expect(encodePermission(back)).toBe(data);
      expect([back.start, back.end, back.salt, back.calls.length, back.spends.length]).toEqual([
        p.start,
        p.end,
        p.salt,
        p.calls.length,
        p.spends.length,
      ]);
    }
  });

  it("starts with the tuple's offset, then account, spender and start, as GooseGuard's register reads them", () => {
    const data = encodePermission(grantPermission(grantOf("protect"), user, GUARD));
    expect(data.slice(0, 66)).toBe(`0x${"20".padStart(64, "0")}`);
    // Word 3 is the start: the high-water mark `permissionOf` keeps after `unregister`.
    expect(heldStartOf(data)).toBe(window.start);
    expect(heldStartOf("0x")).toBe(0);
  });

  it("refuses bytes that aren't a permission", () => {
    expect(() => decodePermission("0x1234")).toThrow();
  });
});

describe("buildRegisterCalls: one register(job, permission) a grant, to GooseGuard, from the user", () => {
  it("sends each permission's bytes with its own job", () => {
    const grants = [own("protect"), own("sell")];
    const calls = buildRegisterCalls(user, grants);
    expect(calls).toHaveLength(2);
    calls.forEach((c, i) => {
      expect(c.to).toBe(GUARD);
      expect(c.value).toBe(0n);
      expect(c.data.slice(0, 10)).toBe(toFunctionSelector("register(uint8,bytes)"));
      const { functionName, args } = fn(c.data);
      expect(functionName).toBe("register");
      expect(args).toEqual([JOBS.indexOf(grants[i].job), encodePermission(grants[i].p)]);
    });
    expect(() => buildRegisterCalls(user, [])).toThrow(/Nothing to register/);
  });

  it("only for the user's own grants to the Guard, each as its own job (the allowlist; a release blocker)", () => {
    const send = (job: number, p: JawPermission, value = 0n) =>
      assertAllowed(user, [
        {
          to: GUARD,
          data: encodeFunctionData({ abi: guardAbi, functionName: "register", args: [job, encodePermission(p)] }),
          value,
        },
      ]);
    const { p } = own("protect");
    expect(send(1, p)).toHaveLength(1);
    // The Guard only runs its own fixed calls for the job it is told: a grant registered as another job is refused.
    for (const job of [0, 2, 3, 4, 5]) expect(() => send(job, p)).toThrow(/Blocked: unexpected arguments to register/);
    expect(() => send(2, own("rebalance").p)).toThrow(/Blocked: unexpected arguments to register/);
    expect(() => send(1, { ...p, account: someoneElse })).toThrow(/Blocked: unexpected arguments to register/);
    expect(() => send(1, { ...p, spender: someoneElse })).toThrow(/Blocked: unexpected arguments to register/);
    expect(() => send(1, p, 1n)).toThrow(/Blocked: unexpected value/);
    expect(() => buildRegisterCalls(user, [{ job: "protect", p: { ...p, account: someoneElse } }])).toThrow(/Blocked/);
    expect(() => buildRegisterCalls(user, [{ job: "save", p }])).toThrow(/Blocked/);
    const garbage = encodeFunctionData({ abi: guardAbi, functionName: "register", args: [1, "0x1234"] });
    expect(() => assertAllowed(user, [{ to: GUARD, data: garbage, value: 0n }])).toThrow(
      /Blocked: unexpected arguments to register/,
    );
    expect(() => assertAllowed(user, [{ to: zeroAddress, data: send(1, p)[0].data, value: 0n }])).toThrow(
      /Blocked: unexpected target/,
    );
  });

  it("is keyed by the account and the grants' jobs and salts", () => {
    const g = own("protect");
    expect(registerPlan(user, [g]).key).toBe(registerPlan(user, [{ ...g }]).key);
    expect(registerPlan(user, [g]).key).not.toBe(registerPlan(user, [{ ...g, p: { ...g.p, salt: 1n } }]).key);
    expect(registerPlan(user, [g]).key).not.toBe(registerPlan(user, [g, { ...g, p: { ...g.p, salt: 1n } }]).key);
  });
});

describe("the Guard's own calls the allowlist lets the account send: unregister, endRescue, the settings", () => {
  it("unregisters a job by its id, and nothing past the five jobs", () => {
    const calls = buildUnregisterCalls(user, ["rebalance", "sell"]);
    expect(calls.map((c) => [c.to, fn(c.data).functionName, fn(c.data).args])).toEqual([
      [GUARD, "unregister", [3]],
      [GUARD, "unregister", [2]],
    ]);
    expect(buildUnregisterCalls(user, [])).toEqual([]);
    const bad = encodeFunctionData({ abi: guardAbi, functionName: "unregister", args: [5] });
    expect(() => assertAllowed(user, [{ to: GUARD, data: bad, value: 0n }])).toThrow(/Blocked/);
  });

  it("ends the rescue with exactly endRescue(), nothing after it", () => {
    const [c] = endRescueCalls(user, true);
    expect(c).toEqual({ to: GUARD, data: toFunctionSelector("endRescue()"), value: 0n });
    expect(() => assertAllowed(user, [{ ...c, data: `${c.data}00` }])).toThrow(/Blocked/);
    expect(() => assertAllowed(user, [{ ...c, value: 1n }])).toThrow(/Blocked: unexpected value/);
  });

  it("packs the mix as the Guard keeps it, 16 bits a stock, and refuses one that doesn't add up", () => {
    const mix = [5_000, 0, 0, 0, 0, 5_000, 0];
    const [c] = buildSetMixCalls(user, mix);
    const { functionName, args } = fn(c.data);
    expect(functionName).toBe("setMix");
    expect(args[0]).toBe(packMix(mix));
    expect(unpackMix(packMix(mix))).toEqual(mix);
    expect(packMix(mix)).toBe(5_000n | (5_000n << 80n));
    const bad = encodeFunctionData({
      abi: guardAbi,
      functionName: "setMix",
      args: [packMix([5_000, 0, 0, 0, 0, 4_000, 0])],
    });
    expect(() => assertAllowed(user, [{ to: GUARD, data: bad, value: 0n }])).toThrow(/Blocked/);
    // setProtect and setRunner have no screen yet: the allowlist names no rule for them.
    const runner = encodeFunctionData({ abi: guardAbi, functionName: "setRunner", args: [someoneElse] });
    expect(() => assertAllowed(user, [{ to: GUARD, data: runner, value: 0n }])).toThrow(/Blocked/);
    const protect = encodeFunctionData({ abi: guardAbi, functionName: "setProtect", args: [10_300, 11_200] });
    expect(() => assertAllowed(user, [{ to: GUARD, data: protect, value: 0n }])).toThrow(/Blocked/);
  });
});

describe("a change's last batch: its settings and its registrations, in one sheet (Adrian, 2026-10-20)", () => {
  const mix = [5_000, 0, 0, 0, 0, 5_000, 0];

  it("puts the settings first, then one register per grant, all allowlisted", () => {
    const g = own("rebalance");
    const calls = buildRegisterCalls(user, [g], buildSetMixCalls(user, mix));
    expect(calls.map((c) => fn(c.data).functionName)).toEqual(["setMix", "register"]);
    expect(
      buildRegisterCalls(user, [own("protect"), own("sell")], buildSetKeepMixCalls(user, true)).map(
        (c) => fn(c.data).functionName,
      ),
    ).toEqual(["setKeepMix", "register", "register"]);
    // Settings alone (a grant registered meanwhile) still make a batch; someone else's grant never does.
    expect(buildRegisterCalls(user, [], buildSetMixCalls(user, mix))).toHaveLength(1);
    expect(() =>
      buildRegisterCalls(user, [{ ...g, p: { ...g.p, account: someoneElse } }], buildSetMixCalls(user, mix)),
    ).toThrow(/Blocked/);
  });

  it("keys the plan by its settings too, so a kept batch is sent only for the same change", () => {
    const g = own("rebalance");
    expect(registerPlan(user, [g], buildSetMixCalls(user, mix)).key).not.toBe(registerPlan(user, [g]).key);
    expect(registerPlan(user, [g], buildSetMixCalls(user, mix)).key).not.toBe(
      registerPlan(user, [g], buildSetMixCalls(user, [10_000, 0, 0, 0, 0, 0, 0])).key,
    );
    expect(registerPlan(user, [g], buildSetMixCalls(user, mix)).key).toBe(
      registerPlan(user, [g], buildSetMixCalls(user, [...mix])).key,
    );
  });

  it("counts one batch for a change that grants anything, however many grants it carries", () => {
    expect(changeSheets(0)).toBe(0);
    expect(changeSheets(1)).toBe(1);
    expect(changeSheets(2)).toBe(1);
  });
});

describe("pickFor: a new grant's start (spec-final-v2.md §5)", () => {
  const nowMs = 1_760_000_000_000;
  const now = nowMs / 1000;

  it("is max(held start + 1, min(device clock, chain head) − 300)", () => {
    expect(pickFor(user, "save", "a", 0, now + 120, nowMs).start).toBe(now - 300); // a phone behind Base
    expect(pickFor(user, "save", "b", 0, now - 600, nowMs).start).toBe(now - 900); // a phone ahead of Base
    expect(pickFor(user, "save", "c", now - 10, now, nowMs).start).toBe(now - 10); // a newer grant held
  });

  it("is never after the device's clock or Base's head, so GooseGuard never refuses it as FutureStart", () => {
    for (const head of [now - 3_600, now, now + 3_600]) {
      const { start } = pickFor(user, "protect", `h${head}`, 0, head, nowMs);
      expect(start).toBeLessThanOrEqual(Math.min(now, head));
    }
  });
});

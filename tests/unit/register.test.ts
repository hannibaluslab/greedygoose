import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, toFunctionSelector, toHex, zeroAddress } from "viem";

const EXECUTOR = vi.hoisted(() => {
  const executor = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_EXECUTOR = executor;
  return executor;
});

import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import {
  agentPermission,
  entryPermission,
  grantPermission,
  jobGrant,
  listedFromGrant,
  readAgentGrant,
  rebalancePermission,
  sellPermission,
  type AgentGrant,
  type JawPermission,
} from "@/lib/agents/permissions";
import { buildRegisterCalls, decodePermission, encodePermission } from "@/lib/agents/register";
import { changeSheets } from "@/lib/agents/status";
import { buildSetKeepMixCalls, buildSetMixCalls } from "@/lib/agents/settings";
import { assertAllowed } from "@/lib/allowlist";
import { registerPlan } from "@/lib/tx/plans";
import { EQUITIES } from "@/lib/tokens/registry";

const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const someoneElse = "0x00000000000000000000000000000000000a11ce" as const;
const window = { start: 1_760_000_000, end: 1_791_536_000, salt: 0xabcdefn };
// Protect may sell NVIDIA and Tesla; the Rebalancer may sell Apple.
const sellLimits = EQUITIES.map((e) =>
  e.symbol === "NVDAc" ? 250_000_000n : e.symbol === "TSLAc" ? 100_000_000n : 0n,
);
const rebalanceLimits = EQUITIES.map((e) => (e.symbol === "AAPLc" ? 50_000_000n : 0n));

const grantOf = (job: AgentGrant["job"], over: Partial<AgentGrant> = {}): AgentGrant => ({
  job,
  permissionId: `0x${"ab".repeat(32)}`,
  capRaw: 5_000_000n,
  ...window,
  ...(job === "sell" && { limitsRaw: sellLimits }),
  ...(job === "rebalance" && { limitsRaw: rebalanceLimits }),
  ...over,
});

describe("grantPermission: the permission JAW put on-chain for a grant of ours", () => {
  it("is each job's own builder, with JAW's start, end and salt", () => {
    const signed = { account: user, spender: EXECUTOR, ...window, capRaw: 5_000_000n };
    expect(grantPermission(grantOf("save"), user, EXECUTOR)).toEqual(agentPermission("save", signed));
    expect(grantPermission(grantOf("protect"), user, EXECUTOR)).toEqual(agentPermission("protect", signed));
    expect(grantPermission(grantOf("sell"), user, EXECUTOR)).toEqual(
      sellPermission({ ...signed, limitsRaw: sellLimits }),
    );
    expect(grantPermission(grantOf("rebalance"), user, EXECUTOR)).toEqual(
      rebalancePermission({ ...signed, limitsRaw: rebalanceLimits }),
    );
    expect(grantPermission(grantOf("entry"), user, EXECUTOR)).toEqual(entryPermission(signed));
  });

  it("needs a limit per stock for the jobs that sell", () => {
    expect(() => grantPermission(grantOf("sell", { limitsRaw: undefined }), user, EXECUTOR)).toThrow(/per stock/);
  });

  it("reads JAW's grant response like its list: hex allowance and salt, no checker", () => {
    const grant = jobGrant("sell", 5_000_000n, sellLimits);
    const response = {
      account: user,
      spender: EXECUTOR,
      start: window.start,
      end: window.end,
      salt: toHex(window.salt),
      calls: grant.calls!.map((c) => ({ target: c.target, selector: c.selector })),
      spends: grant.spends!.map((s) => ({ ...s, allowance: toHex(BigInt(s.allowance)), multiplier: 1 })),
      permissionId: `0x${"cd".repeat(32)}`,
      chainId: "0x2105",
    };
    const read = readAgentGrant(listedFromGrant(response), EXECUTOR);
    expect(read).toEqual({ ...grantOf("sell"), permissionId: response.permissionId });
    // A response for anything else isn't one of ours, so nothing is registered for it.
    expect(readAgentGrant(listedFromGrant({ ...response, spender: someoneElse }), EXECUTOR)).toBeNull();
  });
});

describe("the registration's bytes: abi.encode(permission), as the manager's PermissionApproved logs it", () => {
  const jobs = ["save", "protect", "sell", "rebalance", "entry"] as const;

  it("round-trips every job's permission", () => {
    for (const job of jobs) {
      const p = grantPermission(grantOf(job), user, EXECUTOR);
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

  it("starts with the tuple's offset, as an event's single dynamic argument does", () => {
    const data = encodePermission(grantPermission(grantOf("protect"), user, EXECUTOR));
    expect(data.slice(0, 66)).toBe(`0x${"20".padStart(64, "0")}`);
  });

  it("refuses bytes that aren't a permission", () => {
    expect(() => decodePermission("0x1234")).toThrow();
  });
});

describe("buildRegisterCalls: one registerApproved a grant, to the executor, from the user", () => {
  it("sends each permission's bytes to registerApproved", () => {
    const ps = [grantPermission(grantOf("protect"), user, EXECUTOR), grantPermission(grantOf("sell"), user, EXECUTOR)];
    const calls = buildRegisterCalls(user, ps);
    expect(calls).toHaveLength(2);
    calls.forEach((c, i) => {
      expect(c.to).toBe(EXECUTOR);
      expect(c.value).toBe(0n);
      expect(c.data.slice(0, 10)).toBe(toFunctionSelector("registerApproved(bytes)"));
      const { args } = decodeFunctionData({ abi: gooseExecutorAbi, data: c.data });
      expect(args[0]).toBe(encodePermission(ps[i]));
    });
    expect(() => buildRegisterCalls(user, [])).toThrow(/Nothing to register/);
  });

  it("only for the user's own grants to this executor (the allowlist)", () => {
    const send = (p: JawPermission, value = 0n) =>
      assertAllowed(user, [
        {
          to: EXECUTOR,
          data: encodeFunctionData({
            abi: gooseExecutorAbi,
            functionName: "registerApproved",
            args: [encodePermission(p)],
          }),
          value,
        },
      ]);
    const own = grantPermission(grantOf("protect"), user, EXECUTOR);
    expect(send(own)).toHaveLength(1);
    expect(() => send({ ...own, account: someoneElse })).toThrow(/Blocked: unexpected arguments to registerApproved/);
    expect(() => send({ ...own, spender: someoneElse })).toThrow(/Blocked: unexpected arguments to registerApproved/);
    expect(() => send(own, 1n)).toThrow(/Blocked: unexpected value/);
    expect(() => buildRegisterCalls(user, [{ ...own, account: someoneElse }])).toThrow(/Blocked/);
    const garbage = encodeFunctionData({ abi: gooseExecutorAbi, functionName: "registerApproved", args: ["0x1234"] });
    expect(() => assertAllowed(user, [{ to: EXECUTOR, data: garbage, value: 0n }])).toThrow(
      /Blocked: unexpected arguments to registerApproved/,
    );
    expect(() => assertAllowed(user, [{ to: zeroAddress, data: send(own)[0].data, value: 0n }])).toThrow(
      /Blocked: unexpected target/,
    );
  });

  it("is keyed by the account and the grants' salts", () => {
    const p = grantPermission(grantOf("protect"), user, EXECUTOR);
    expect(registerPlan(user, [p]).key).toBe(registerPlan(user, [{ ...p }]).key);
    expect(registerPlan(user, [p]).key).not.toBe(registerPlan(user, [{ ...p, salt: 1n }]).key);
    expect(registerPlan(user, [p]).key).not.toBe(registerPlan(user, [p, { ...p, salt: 1n }]).key);
  });
});

describe("a change's last batch: its settings and its registrations, in one sheet (Adrian, 2026-10-20)", () => {
  const mix = [5_000, 0, 0, 0, 0, 5_000, 0];

  it("puts the settings first, then one registerApproved per grant, all allowlisted", () => {
    const p = grantPermission(grantOf("rebalance"), user, EXECUTOR);
    const calls = buildRegisterCalls(user, [p], buildSetMixCalls(user, mix));
    expect(calls.map((c) => decodeFunctionData({ abi: gooseExecutorAbi, data: c.data }).functionName)).toEqual([
      "setMix",
      "registerApproved",
    ]);
    const protect = [
      grantPermission(grantOf("protect"), user, EXECUTOR),
      grantPermission(grantOf("sell"), user, EXECUTOR),
    ];
    expect(
      buildRegisterCalls(user, protect, buildSetKeepMixCalls(user, true)).map(
        (c) => decodeFunctionData({ abi: gooseExecutorAbi, data: c.data }).functionName,
      ),
    ).toEqual(["setKeepMix", "registerApproved", "registerApproved"]);
    // Settings alone (a grant registered meanwhile) still make a batch; someone else's grant never does.
    expect(buildRegisterCalls(user, [], buildSetMixCalls(user, mix))).toHaveLength(1);
    expect(() => buildRegisterCalls(user, [{ ...p, account: someoneElse }], buildSetMixCalls(user, mix))).toThrow(
      /Blocked/,
    );
  });

  it("keys the plan by its settings too, so a kept batch is sent only for the same change", () => {
    const p = grantPermission(grantOf("rebalance"), user, EXECUTOR);
    expect(registerPlan(user, [p], buildSetMixCalls(user, mix)).key).not.toBe(registerPlan(user, [p]).key);
    expect(registerPlan(user, [p], buildSetMixCalls(user, mix)).key).not.toBe(
      registerPlan(user, [p], buildSetMixCalls(user, [10_000, 0, 0, 0, 0, 0, 0])).key,
    );
    expect(registerPlan(user, [p], buildSetMixCalls(user, mix)).key).toBe(
      registerPlan(user, [p], buildSetMixCalls(user, [...mix])).key,
    );
  });

  it("counts one batch for a change that grants anything, however many grants it carries", () => {
    expect(changeSheets(0)).toBe(0);
    expect(changeSheets(1)).toBe(1);
    expect(changeSheets(2)).toBe(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionData, type Hex } from "viem";

const GUARD = vi.hoisted(() => {
  const guard = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_GUARD = guard;
  return guard;
});

import { decodeFunctionResult, encodeFunctionResult } from "viem";
import { explainRevert } from "@/lib/aave/errors";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import {
  addManagerOwnerCall,
  approveCall,
  contractPermission,
  jawPermission,
  RELAY_PERMISSIONS_URL,
  relayRecord,
} from "@/lib/agents/oneTapGrant";
import { agentJobOf } from "@/lib/agents/agentJob";
import {
  GRANT_SECONDS,
  jobGrant,
  JOBS,
  stockLimitsRaw,
  type AgentGrant,
  type AgentJob,
} from "@/lib/agents/permissions";
import { pickFor } from "@/lib/agents/picks";
import { deleteFromRelay, recordInRelay, relayPermission, sameRecord, type RelayDeps } from "@/lib/agents/relay";
import { buildRegisterCalls, encodePermission } from "@/lib/agents/register";
import { buildSetKeepMixCalls } from "@/lib/agents/settings";
import { jobStatus } from "@/lib/agents/status";
import { assertAllowed } from "@/lib/allowlist";
import { PROTOCOLS } from "@/lib/protocols/config";
import { permissionManagerAbi } from "@/lib/protocols/abis";
import { EQUITIES } from "@/lib/tokens/registry";
import { agentChangePlan, revokeCall } from "@/lib/tx/plans";

const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const someoneElse = "0x00000000000000000000000000000000000a11ce" as const;
const MANAGER = PROTOCOLS.PERMISSION_MANAGER as `0x${string}`;
const NOW = Math.floor(Date.now() / 1000);
const sellLimits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "TSLAc"));

/** A job's grant as a one-signature change builds it: JAW's struct with the app's start and salt, a year long. */
const grantOf = (job: AgentJob, salt = 7n, start = NOW - 300) =>
  jawPermission(
    user,
    GUARD,
    start + GRANT_SECONDS,
    jobGrant(job, job === "sell" || job === "rebalance" ? sellLimits : undefined),
    {
      start,
      salt,
    },
  );
const register = (p: ReturnType<typeof grantOf>) =>
  buildRegisterCalls(user, [{ job: agentJobOf(contractPermission(p), user, GUARD)!, p: contractPermission(p) }]);
/** register(job, permission) as any job, past the builders: what a batch could carry. */
const registerAs = (job: number, p: ReturnType<typeof grantOf>) => ({
  to: GUARD,
  data: encodeFunctionData({
    abi: guardAbi,
    functionName: "register",
    args: [job, encodePermission(contractPermission(p))],
  }),
  value: 0n,
});

describe("the allowlist for one-signature grants (D14 dropped, Adrian 2026-10-20)", () => {
  it("lets a batch approve the user's own agent grant when it registers exactly it later", () => {
    const p = grantOf("protect");
    expect(assertAllowed(user, [approveCall(p), ...register(p)])).toHaveLength(2);
    expect(agentJobOf(contractPermission(p), user, GUARD)).toBe("protect");
    expect(agentJobOf(contractPermission(grantOf("sell")), user, GUARD)).toBe("sell");
  });

  it("never someone else's grant, another spender, another window or a start ahead of the clock", () => {
    const p = grantOf("protect");
    const approveOf = (over: Partial<ReturnType<typeof grantOf>>) => approveCall({ ...p, ...over });
    expect(() => assertAllowed(user, [approveOf({ account: someoneElse })])).toThrow(/Blocked/);
    expect(() => assertAllowed(user, [approveOf({ spender: someoneElse })])).toThrow(/Blocked/);
    expect(() => assertAllowed(user, [approveOf({ end: p.end + 1 })])).toThrow(/Blocked/);
    const ahead = grantOf("protect", 7n, NOW + 3_600);
    expect(() => assertAllowed(user, [approveCall(ahead), ...register(ahead)])).toThrow(/Blocked/);
    // No start ahead of the clock at all: GooseGuard refuses one after the block it lands in (FutureStart).
    const aMinute = grantOf("protect", 7n, NOW + 60);
    expect(() => assertAllowed(user, [approveCall(aMinute), ...register(aMinute)])).toThrow(/Blocked/);
    expect(agentJobOf(contractPermission(p), someoneElse, GUARD)).toBeNull();
  });

  it("never anything but a job's exact template", () => {
    const p = grantOf("protect");
    const extra = {
      ...p,
      calls: [...p.calls, { target: someoneElse, selector: "0x12345678" as Hex, checker: p.calls[0].checker }],
    };
    expect(() => assertAllowed(user, [approveCall(extra)])).toThrow(/Blocked/);
    const doubled = { ...p, spends: p.spends.map((s) => ({ ...s, multiplier: 2 })) };
    expect(() => assertAllowed(user, [approveCall(doubled)])).toThrow(/Blocked/);
  });

  it("pairs every approve with its registration, after it, one approve a job", () => {
    const p = grantOf("protect");
    const q = grantOf("protect", 8n);
    expect(() => assertAllowed(user, [approveCall(p)])).toThrow(/isn’t switched on in the same batch/);
    expect(() => assertAllowed(user, [...register(p), approveCall(p)])).toThrow(/isn’t switched on/);
    expect(() => assertAllowed(user, [approveCall(p), ...register(q)])).toThrow(/isn’t switched on/);
    expect(() => assertAllowed(user, [approveCall(p), approveCall(q), ...register(p), ...register(q)])).toThrow(
      /two grants for one agent/,
    );
    const s = grantOf("sell");
    expect(assertAllowed(user, [approveCall(p), approveCall(s), ...register(p), ...register(s)])).toHaveLength(4);
  });

  it("registers each approved grant as its own job, never another (a release blocker, spec-final-v2.md §5)", () => {
    const p = grantOf("protect");
    expect(assertAllowed(user, [approveCall(p), registerAs(JOBS.indexOf("protect"), p)])).toHaveLength(2);
    for (const job of JOBS.filter((j) => j !== "protect"))
      expect(() => assertAllowed(user, [approveCall(p), registerAs(JOBS.indexOf(job), p)])).toThrow(/Blocked/);
    // The Rebalancer's grant registered as Protect · sell, whose moves sell stock that backs credit.
    const r = grantOf("rebalance");
    expect(() => assertAllowed(user, [registerAs(JOBS.indexOf("sell"), r)])).toThrow(/Blocked/);
  });

  it("adds the manager as an owner of the account only once, before an approve, and nothing else on the account", () => {
    const p = grantOf("protect");
    const owner = addManagerOwnerCall(user);
    expect(assertAllowed(user, [owner, approveCall(p), ...register(p)])).toHaveLength(3);
    expect(() => assertAllowed(user, [owner])).toThrow(/unexpected owner change/);
    expect(() => assertAllowed(user, [approveCall(p), owner, ...register(p)])).toThrow(/unexpected owner change/);
    expect(() => assertAllowed(user, [owner, owner, approveCall(p), ...register(p)])).toThrow(/owner change/);
    const other = {
      to: user,
      data: encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "addOwnerAddress",
            inputs: [{ name: "o", type: "address" }],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "addOwnerAddress",
        args: [someoneElse],
      }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [other, approveCall(p), ...register(p)])).toThrow(/unexpected owner change/);
    expect(() => assertAllowed(user, [{ ...owner, data: "0xdeadbeef" }])).toThrow(/Blocked/);
    expect(() => assertAllowed(user, [{ ...owner, value: 1n }])).toThrow(/unexpected value/);
  });

  it("lets a batch revoke only the user's own agent grants", () => {
    const p = contractPermission(grantOf("sell"));
    expect(assertAllowed(user, [revokeCall(p)])).toHaveLength(1);
    expect(() => assertAllowed(user, [revokeCall({ ...p, account: someoneElse })])).toThrow(/Blocked/);
    expect(() => assertAllowed(user, [revokeCall({ ...p, spender: someoneElse })])).toThrow(/Blocked/);
  });
});

describe("agentChangePlan: a change in one batch", () => {
  const owner = addManagerOwnerCall(user);
  const deps = { getCode: () => Promise.resolve("0x6001" as Hex), ownerCalls: () => Promise.resolve([owner]) };

  it("puts what goes first, the revokes, the owner call, the approves, the settings, then the registrations", async () => {
    const p = grantOf("protect");
    const old = contractPermission(grantOf("protect", 3n, NOW - 9_000));
    const keep = buildSetKeepMixCalls(user, true);
    const plan = agentChangePlan(user, { grants: [p], revokes: [old], settings: keep }, deps);
    const batch = await (plan.calls as () => Promise<{ to: string; data: Hex }[]>)();
    const names = batch.map((c) => {
      if (c.to === user) return "owner";
      if (c.to === MANAGER) return decodeFunctionData({ abi: permissionManagerAbi, data: c.data }).functionName;
      return decodeFunctionData({ abi: guardAbi, data: c.data }).functionName;
    });
    expect(names).toEqual(["revoke", "owner", "approve", "setKeepMix", "register"]);
  });

  it("turns off with revokes alone, and is keyed by every salt, the settings and what goes first", async () => {
    const off = agentChangePlan(user, { grants: [], revokes: [contractPermission(grantOf("sell"))] }, deps);
    expect(await (off.calls as () => Promise<unknown[]>)()).toHaveLength(1);
    const a = agentChangePlan(user, { grants: [grantOf("protect", 1n)] }, deps).key;
    expect(agentChangePlan(user, { grants: [grantOf("protect", 1n)] }, deps).key).toBe(a);
    expect(agentChangePlan(user, { grants: [grantOf("protect", 2n)] }, deps).key).not.toBe(a);
    expect(
      agentChangePlan(user, { grants: [grantOf("protect", 1n)], settings: buildSetKeepMixCalls(user, true) }, deps).key,
    ).not.toBe(a);
  });

  it("simulates every call of a deployed account's batch", async () => {
    const plan = agentChangePlan(user, { grants: [grantOf("save")] }, deps);
    const batch = await (plan.calls as () => Promise<{ to: `0x${string}`; data: Hex; value: bigint }[]>)();
    expect(plan.simulated?.(batch)).toEqual(batch);
  });

  it("an account JAW hasn't deployed yet: one batch, simulated without its registrations, no owner call read", async () => {
    const ownerCalls = vi.fn(() => Promise.resolve([owner]));
    const fresh = { getCode: () => Promise.resolve(undefined), ownerCalls };
    const plan = agentChangePlan(user, { grants: [grantOf("save")] }, fresh);
    const batch = await (plan.calls as () => Promise<{ to: `0x${string}`; data: Hex; value: bigint }[]>)();
    const fn = (c: { to: string; data: Hex }) =>
      c.to === MANAGER
        ? decodeFunctionData({ abi: permissionManagerAbi, data: c.data }).functionName
        : decodeFunctionData({ abi: guardAbi, data: c.data }).functionName;
    // The whole batch is signed: the approve and its registration, no owner call (JAW's factory makes the manager one).
    expect(batch.map(fn)).toEqual(["approve", "register"]);
    expect(ownerCalls).not.toHaveBeenCalled();
    // The check simulates all of it but the registration, which only passes once the account is deployed.
    expect(plan.simulated?.(batch).map(fn)).toEqual(["approve"]);
  });

  it("hands the receipts to `landed` for the change's records", async () => {
    const landed = vi.fn(() => Promise.resolve());
    const plan = agentChangePlan(user, { grants: [grantOf("save")] }, { ...deps, landed });
    await plan.landed?.([{ logs: [] }]);
    expect(landed).toHaveBeenCalledWith([{ logs: [] }]);
  });
});

describe("JAW's relay: the app records a one-signature grant as JAW's own grant would", () => {
  const p = grantOf("sell");
  const id = `0x${"cd".repeat(32)}` as Hex;
  const chainId = 8453;

  it("reads the manager's struct back in JAW's words", () => {
    expect(relayPermission(contractPermission(p))).toEqual(p);
    expect(
      relayPermission({ ...contractPermission(p), spends: [{ ...contractPermission(p).spends[0], unit: 9 }] }),
    ).toBeNull();
  });

  it("takes a record that matches field for field, whatever its hex case, and nothing else", () => {
    const r = relayRecord(id, p, chainId);
    expect(sameRecord(r, id, p, chainId)).toBe(true);
    expect(sameRecord({ ...r, account: r.account.toLowerCase() as `0x${string}` }, id, p, chainId)).toBe(true);
    expect(sameRecord({ ...r, end: r.end + 1 }, id, p, chainId)).toBe(false);
    expect(sameRecord({ ...r, spender: someoneElse }, id, p, chainId)).toBe(false);
  });

  it("stores only when the relay doesn't have it, counts 'already exists' as stored, and never throws", async () => {
    const store = vi.fn(() => Promise.resolve({}));
    const there: RelayDeps = { get: () => Promise.resolve(relayRecord(id, p, chainId)), store };
    expect(await recordInRelay(id, p, chainId, there)).toBe(true);
    expect(store).not.toHaveBeenCalled();

    const missing: RelayDeps = { get: () => Promise.reject(new Error("Not found")), store };
    expect(await recordInRelay(id, p, chainId, missing)).toBe(true);
    expect(store).toHaveBeenCalledWith(id, p);

    const squatted: RelayDeps = { get: () => Promise.resolve({ ...relayRecord(id, p, chainId), end: 1 }), store };
    expect(await recordInRelay(id, p, chainId, squatted)).toBe(true);

    const already = Object.assign(new Error("Permission already exists"), { status: 400 });
    expect(await recordInRelay(id, p, chainId, { ...missing, store: () => Promise.reject(already) })).toBe(true);
    const down = Object.assign(new Error("Internal error"), { status: 500 });
    expect(await recordInRelay(id, p, chainId, { ...missing, store: () => Promise.reject(down) })).toBe(false);
  });

  it("takes a revoked grant's record out as JAW's revoke does, and says when it couldn't", async () => {
    const fetchFn = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    expect(await deleteFromRelay(id, "key-not-real", fetchFn as unknown as typeof fetch)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(`${RELAY_PERMISSIONS_URL}/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json, text/plain, */*", "x-api-key": "key-not-real" },
    });
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await deleteFromRelay(id, undefined, failing)).toBe(false);
  });
});

describe("picks: one start and salt per account, job and terms, until the Guard holds a newer grant", () => {
  /** Base's head, ahead of the device's clock: the device's clock decides. */
  const head = (ms: number) => ms / 1000 + 60;

  it("holds a pick from render to render and starts it five minutes behind the clock", () => {
    const at = 1_800_000_000_000;
    const a = pickFor(user, "protect", "terms-a", 1, head(at), at);
    expect(pickFor(user, "protect", "terms-a", 1, head(at), at + 60_000)).toBe(a);
    expect(a.start).toBe(at / 1000 - 300);
    expect(pickFor(user, "protect", "terms-b", 1, head(at), at)).not.toBe(a);
    expect(pickFor(someoneElse, "protect", "terms-a", 1, head(at), at)).not.toBe(a);
  });

  it("picks again after ten minutes, so a grant signed later still runs about a year from then", () => {
    const at = 1_900_000_000_000;
    const a = pickFor(user, "rebalance", "t", 1, head(at), at);
    expect(pickFor(user, "rebalance", "t", 1, head(at), at + 9 * 60_000)).toBe(a);
    const later = at + 11 * 60_000;
    const b = pickFor(user, "rebalance", "t", 1, head(later), later);
    expect(b).not.toBe(a);
    expect(b.start).toBe(later / 1000 - 300);
  });

  it("picks again when the grant the Guard holds started later, never at or before it", () => {
    const at = 1_800_000_000_000;
    const a = pickFor(user, "sell", "t", 1, head(at), at);
    const b = pickFor(user, "sell", "t", a.start + 10, head(at), at);
    expect(b).not.toBe(a);
    expect(b.start).toBe(a.start + 10);
  });

  it("starts behind Base's head when the device's clock runs ahead of it", () => {
    const at = 1_700_000_000_000;
    expect(pickFor(user, "save", "fast-phone", 1, at / 1000 - 600, at).start).toBe(at / 1000 - 900);
  });
});

describe("jobStatus reads Base: registered, not ended, and alive", () => {
  const stored = { start: NOW - 100, end: NOW + 100, salt: 1n };
  const grant: AgentGrant = {
    job: "protect",
    permissionId: "0x01",
    start: NOW - 100,
    end: NOW + 100,
    salt: 1n,
  };
  const bit = 1 << 1;

  it("is on while alive, whatever JAW's list says, and off once revoked", () => {
    expect(jobStatus("protect", bit, stored, [], NOW, false, true)).toBe("on");
    expect(jobStatus("protect", bit, stored, [], NOW, false, false)).toBe("off");
    // The grant the Guard kept, switched off: off, not waiting to start. Only a newer listed one is.
    expect(jobStatus("protect", bit, stored, [grant], NOW, false, false)).toBe("off");
    expect(jobStatus("protect", 0, stored, [{ ...grant, start: NOW - 10, salt: 2n }], NOW, false, false)).toBe(
      "starting",
    );
    expect(jobStatus("protect", 0, stored, [], NOW, false, true)).toBe("off");
    expect(jobStatus("protect", bit, { ...stored, end: NOW - 1 }, [], NOW, false, true)).toBe("off");
  });

  it("falls back to JAW's list only while Base can't say", () => {
    expect(jobStatus("protect", bit, stored, [grant], NOW, false)).toBe("on");
    expect(jobStatus("protect", bit, stored, [], NOW, false)).toBe("off");
    expect(jobStatus("protect", bit, stored, [], NOW, true)).toBe("on");
  });
});

describe("GooseGuard's refusals in plain words, unwrapped from the account's ExecuteError", () => {
  const fallback = "fallback";
  const error = (errorName: Parameters<typeof encodeErrorResult<typeof guardAbi>>[0]["errorName"]) =>
    encodeErrorResult({ abi: guardAbi, errorName } as never);
  const notAccount = error("NotAccount");

  it("says each refusal of a turn-on as it is", () => {
    expect(explainRevert(notAccount, fallback)).toMatch(/isn’t set up for your account/);
    expect(explainRevert(error("NotSpender"), fallback)).toMatch(/another app/);
    expect(explainRevert(error("FutureStart"), fallback)).toMatch(/clock runs ahead/);
    expect(explainRevert(error("Expired"), fallback)).toMatch(/time window has passed/);
    expect(explainRevert(error("StaleGrant"), fallback)).toMatch(/newer setting/);
    expect(explainRevert(error("CodeNotAllowed"), fallback)).toMatch(/can’t run on this account/);
    expect(explainRevert(error("TooLong"), fallback)).toMatch(/settings can’t be used/);
    expect(explainRevert(error("BadJob"), fallback)).toMatch(/settings can’t be used/);
    expect(explainRevert(error("BadMix"), fallback)).toMatch(/100%/);
  });

  it("reads the call's own revert out of ExecuteError(index, error)", () => {
    const wrapped =
      `0x5a154675${encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [2n, notAccount]).slice(2)}` as Hex;
    expect(explainRevert(wrapped, fallback)).toBe(explainRevert(notAccount, fallback));
    expect(explainRevert("0x5a154675", fallback)).toBe(fallback);
  });
});

describe("accountOf(): the Guard's account and settings, read by name, never by position", () => {
  it("decodes the job bits, the rescue, the pacing, the mix and top-ups", () => {
    const data = encodeFunctionResult({
      abi: guardAbi,
      functionName: "accountOf",
      result: [
        { index: 4, jobs: 0b01011, rescueAt: 1_760_000_000, sessionAt: 1_760_100_000, runner: someoneElse },
        {
          mix: 5_000n | (5_000n << 80n),
          line: 0,
          target: 0,
          mixSetAt: 1_760_200_000,
          keepMix: true,
          topUpsOn: true,
          keep: 500_000_000,
        },
      ],
    });
    const [a, s] = decodeFunctionResult({ abi: guardAbi, functionName: "accountOf", data });
    expect(a).toMatchObject({ jobs: 0b01011, rescueAt: 1_760_000_000, sessionAt: 1_760_100_000 });
    expect(s).toMatchObject({ mix: 5_000n | (5_000n << 80n), mixSetAt: 1_760_200_000, keepMix: true, topUpsOn: true });
    expect(s.keep).toBe(500_000_000);
  });
});

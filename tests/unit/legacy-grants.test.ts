import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, maxUint160, zeroAddress, type Hex } from "viem";

const GUARD = vi.hoisted(() => {
  const guard = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_GUARD = guard;
  // The old executor is never read from env: a stray value here must change nothing.
  process.env.NEXT_PUBLIC_GOOSE_EXECUTOR = "0x00000000000000000000000000000000000bad00";
  return guard;
});

import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import {
  LEGACY_EXECUTOR,
  isLegacyGrant,
  legacyCandidates,
  legacyRevokesFor,
  legacyToRevoke,
  listedToPermission,
  type LegacyState,
} from "@/lib/agents/legacy";
import { addManagerOwnerCall, approveCall, contractPermission, jawPermission } from "@/lib/agents/oneTapGrant";
import { GRANT_SECONDS, PERIOD, jobGrant, type JawPermission, type ListedPermission } from "@/lib/agents/permissions";
import { relayPermission } from "@/lib/agents/relay";
import { assertAllowed } from "@/lib/allowlist";
import { PROTOCOLS, SEL } from "@/lib/protocols/config";
import { permissionManagerAbi } from "@/lib/protocols/abis";
import { USDC } from "@/lib/tokens/registry";
import { agentChangePlan, revokeCall } from "@/lib/tx/plans";

const user = "0xff13dc32aca90b3d61058ea26df1d895f842ee1f" as const;
const someoneElse = "0x00000000000000000000000000000000000a11ce" as const;
const MANAGER = PROTOCOLS.PERMISSION_MANAGER as `0x${string}`;
const NOW = Math.floor(Date.now() / 1000);

/** A grant as main's Save had it on GooseExecutor: a USDC cap a day, a year long (not today's template). */
const mainSave = (salt = 11n, over: Partial<JawPermission> = {}): JawPermission => ({
  account: user,
  spender: LEGACY_EXECUTOR,
  start: NOW - 3 * 86_400,
  end: NOW - 3 * 86_400 + GRANT_SECONDS,
  salt,
  calls: [
    { target: USDC.address, selector: SEL.approve, checker: zeroAddress },
    { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.supply, checker: zeroAddress },
  ],
  spends: [{ token: USDC.address, allowance: 5_000_000_000n, unit: PERIOD.Day, multiplier: 1 }],
  ...over,
});

/** The same grant as JAW's relay lists it (`usePermissions`): words for periods, strings for numbers. */
const listedOf = (p: JawPermission, permissionId: Hex = "0x01"): ListedPermission => {
  const r = relayPermission(p)!;
  return {
    permissionId,
    spender: r.spender,
    start: r.start,
    end: r.end,
    salt: `0x${r.salt.toString(16)}`,
    calls: r.calls.map((c) => ({ target: c.target, selector: c.selector, checker: c.checker })),
    spends: r.spends.map((s) => ({
      token: s.token,
      allowance: s.allowance.toString(),
      unit: s.unit,
      multiplier: s.multiplier,
    })),
  };
};

describe("GG-05: grants left on main's GooseExecutor", () => {
  it("names the executor by a fixed address, never env", () => {
    expect(LEGACY_EXECUTOR).toBe(getAddress("0x686cd88F248DE3F9FC0835566DB798D93881F02D"));
  });

  it("reads JAW's record of any old grant back as exactly the struct the manager approved", () => {
    const p = mainSave();
    expect(listedToPermission(listedOf(p), user)).toEqual(p);
    const weekly = mainSave(12n, {
      spends: [{ token: USDC.address, allowance: maxUint160, unit: PERIOD.Week, multiplier: 1 }],
    });
    expect(listedToPermission(listedOf(weekly), user)).toEqual(weekly);
    // A call with no checker listed is checker 0, as JAW's grant puts it on-chain.
    const bare = listedOf(p);
    bare.calls = bare.calls.map(({ target, selector }) => ({ target, selector }));
    expect(listedToPermission(bare, user)).toEqual(p);
  });

  it("never reads a record that can't be a struct", () => {
    const p = listedOf(mainSave());
    expect(listedToPermission({ ...p, spends: [{ ...p.spends[0], unit: "year" }] }, user)).toBeNull();
    expect(listedToPermission({ ...p, calls: [{ ...p.calls[0], selector: "0x12" }] }, user)).toBeNull();
    expect(listedToPermission({ ...p, spender: "not an address" }, user)).toBeNull();
    expect(listedToPermission({ ...p, salt: "zz" }, user)).toBeNull();
  });

  it("finds each old grant once, from the executor's registry and JAW's list, still in its year", () => {
    const kept = mainSave(1n);
    const listedOnly = mainSave(2n);
    const never = mainSave(0n, { start: 0, end: 0 }); // a job the executor never had: permissionOf reads end 0
    const ended = mainSave(3n, { end: NOW - 60 });
    const found = legacyCandidates(
      user,
      [listedOf(kept), listedOf(listedOnly), listedOf(ended)],
      [kept, never, ended],
      NOW,
    );
    expect(found.map((c) => c.p)).toEqual([kept, listedOnly]);
  });

  it("never someone else's grant, nor one to the Guard or anyone but the old executor", () => {
    const toGuard = jawPermission(user, GUARD, NOW - 300 + GRANT_SECONDS, jobGrant("save"), {
      start: NOW - 300,
      salt: 5n,
    });
    const found = legacyCandidates(
      user,
      [listedOf(contractPermission(toGuard)), listedOf(mainSave(4n, { spender: someoneElse }))],
      [mainSave(6n, { account: someoneElse }), mainSave(7n, { spender: someoneElse })],
      NOW,
    );
    expect(found).toEqual([]);
    expect(isLegacyGrant(mainSave(), user)).toBe(true);
    expect(isLegacyGrant(mainSave(), someoneElse)).toBe(false);
    expect(isLegacyGrant(null, user)).toBe(false);
    expect(isLegacyGrant({ account: user, spender: "nope" }, user)).toBe(false);
  });

  it("revokes only what the manager has approved and not revoked", () => {
    const [a, b, c, d] = [mainSave(1n), mainSave(2n), mainSave(3n), mainSave(4n)];
    const found = legacyCandidates(user, [], [a, b, c, d], NOW);
    const out = legacyToRevoke(found, [
      { id: "0xa1", approved: true, revoked: false },
      { id: "0xb2", approved: true, revoked: true },
      { id: "0xc3", approved: false, revoked: false },
      undefined, // Base hasn't answered for it
    ]);
    expect(out).toEqual([{ id: "0xa1", p: a }]);
  });
});

describe("GG-05: the change that switches agents on or off takes them back", () => {
  const old = { id: "0xa1" as Hex, p: mainSave() };
  const state = (over: Partial<LegacyState> = {}): LegacyState => ({
    known: true,
    unreadable: false,
    revokes: [old],
    ...over,
  });

  it("in any change that grants or turns off a job, never one of settings alone", () => {
    expect(legacyRevokesFor(state(), { granting: true, changingJobs: true })).toEqual([old]);
    expect(legacyRevokesFor(state(), { granting: false, changingJobs: true })).toEqual([old]);
    expect(legacyRevokesFor(state(), { granting: false, changingJobs: false })).toEqual([]);
  });

  it("a new grant waits until Base has said which are left, and says so when it can't be read", () => {
    expect(legacyRevokesFor(state({ known: false }), { granting: true, changingJobs: true })).toBe("wait");
    expect(legacyRevokesFor(state({ known: false, unreadable: true }), { granting: true, changingJobs: true })).toBe(
      "unreadable",
    );
    // A turn-off never waits on them.
    expect(legacyRevokesFor(state({ known: false, revokes: [] }), { granting: false, changingJobs: true })).toEqual([]);
  });

  it("the allowlist lets the account revoke its own old grant, nothing more", () => {
    expect(assertAllowed(user, [revokeCall(mainSave())])).toHaveLength(1);
    expect(() => assertAllowed(user, [revokeCall(mainSave(1n, { account: someoneElse }))])).toThrow(/Blocked/);
    expect(() => assertAllowed(user, [revokeCall(mainSave(1n, { spender: someoneElse }))])).toThrow(/Blocked/);
    // Approving a grant to the old executor stays blocked.
    expect(() => assertAllowed(user, [approveCall(relayPermission(mainSave())!)])).toThrow(/Blocked/);
  });

  it("revokes them first in the one batch that approves and registers the new grant", async () => {
    const deps = {
      getCode: () => Promise.resolve("0x6001" as Hex),
      ownerCalls: () => Promise.resolve([addManagerOwnerCall(user)]),
    };
    const fresh = jawPermission(user, GUARD, NOW - 300 + GRANT_SECONDS, jobGrant("save"), {
      start: NOW - 300,
      salt: 9n,
    });
    const second = mainSave(2n, { calls: mainSave().calls.slice(0, 1) });
    const plan = agentChangePlan(user, { grants: [fresh], revokes: [mainSave(), second] }, deps);
    const batch = await (plan.calls as () => Promise<{ to: string; data: Hex }[]>)();
    const steps = batch.map((c) => {
      if (c.to === user) return "owner";
      if (c.to === MANAGER) {
        const { functionName, args } = decodeFunctionData({ abi: permissionManagerAbi, data: c.data });
        return `${functionName}:${(args[0] as JawPermission).spender === LEGACY_EXECUTOR ? "old" : "guard"}`;
      }
      return decodeFunctionData({ abi: guardAbi, data: c.data }).functionName;
    });
    expect(steps).toEqual(["revoke:old", "revoke:old", "owner", "approve:guard", "register"]);
    // The plan is keyed by what it revokes: a change that finds another old grant is a new batch.
    expect(agentChangePlan(user, { grants: [fresh], revokes: [mainSave()] }, deps).key).not.toBe(plan.key);
  });
});

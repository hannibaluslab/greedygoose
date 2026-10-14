import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toFunctionSelector, toHex, zeroAddress } from "viem";
import {
  agentGrant,
  agentPermission,
  dailyLimitRaw,
  entryGrant,
  entryPermission,
  readAgentGrant,
  rebalanceGrant,
  rebalancePermission,
  sellGrant,
  sellPermission,
  stockTerms,
  type ListedPermission,
} from "@/lib/agents/permissions";
import { jobStatus } from "@/lib/agents/status";
import { PERIOD } from "@/lib/guardian/permission";
import { GUARDIAN, SEL } from "@/lib/guardian/config";
import { AAVE } from "@/lib/aave/addresses";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { agentVectors } from "@/scripts/agent-vectors";

const executor = "0x00000000000000000000000000000000000E5EC0" as const;
const account = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;

describe("agentGrant (what the app sends to JAW's useGrantPermissions)", () => {
  it("Save may approve USDC and supply to the savings pool, within a daily USDC limit", () => {
    expect(agentGrant("save", 5_000_000n)).toEqual({
      calls: [
        { target: USDC.address, selector: SEL.approve },
        { target: GUARDIAN.AAVE_V3_POOL, selector: SEL.supply },
      ],
      spends: [{ token: USDC.address, allowance: "5000000", unit: "day" }],
    });
  });

  it("Protect may withdraw savings, approve USDC and repay, with the same daily limit on USDC and on savings", () => {
    expect(agentGrant("protect", 5_000_000n)).toEqual({
      calls: [
        { target: GUARDIAN.AAVE_V3_POOL, selector: SEL.withdraw },
        { target: USDC.address, selector: SEL.approve },
        { target: AAVE.SPOKE, selector: SEL.repay },
      ],
      spends: [
        { token: USDC.address, allowance: "5000000", unit: "day" },
        { token: GUARDIAN.AUSDC, allowance: "5000000", unit: "day" },
      ],
    });
  });

  it("refuses a zero limit", () => {
    expect(() => agentGrant("save", 0n)).toThrow(/positive/);
  });

  it("lands on-chain with checker 0 and Day × 1, in the same order (JAW's apiPermissionsToPermission)", () => {
    const p = agentPermission("protect", { account, spender: executor, start: 1, end: 2, salt: 7n, capRaw: 5_000_000n });
    expect(p.calls.map((c) => [c.target, c.selector, c.checker])).toEqual(
      agentGrant("protect", 5_000_000n).calls!.map((c) => [c.target, c.selector, zeroAddress]),
    );
    expect(p.spends).toEqual([
      { token: USDC.address, allowance: 5_000_000n, unit: PERIOD.Day, multiplier: 1 },
      { token: GUARDIAN.AUSDC, allowance: 5_000_000n, unit: PERIOD.Day, multiplier: 1 },
    ]);
  });
});

describe("sellGrant (Protect · sell, its own JAW grant)", () => {
  // NVIDIA and Tesla for sale, the other five never: a limit of 0.
  const limits = EQUITIES.map((e) => (e.symbol === "NVDAc" ? 250_000_000n : e.symbol === "TSLAc" ? 100_000_000n : 0n));
  const nvda = EQUITIES[5].address;
  const tsla = EQUITIES[6].address;

  it("may take stock out of Aave, approve only the stocks for sale to Aerodrome, swap, approve USDC and repay", () => {
    expect(sellGrant(5_000_000n, limits)).toEqual({
      calls: [
        { target: AAVE.SPOKE, selector: SEL.spokeWithdraw },
        { target: nvda, selector: SEL.approve },
        { target: tsla, selector: SEL.approve },
        { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
        { target: USDC.address, selector: SEL.approve },
        { target: AAVE.SPOKE, selector: SEL.repay },
      ],
      spends: [
        { token: USDC.address, allowance: "5000000", unit: "day" },
        { token: GUARDIAN.AUSDC, allowance: "5000000", unit: "day" },
        { token: nvda, allowance: "250000000", unit: "day" },
        { token: tsla, allowance: "100000000", unit: "day" },
      ],
    });
  });

  it("uses the selectors the deployed spoke and router expose", () => {
    expect(toFunctionSelector("withdraw(uint256,uint256,address)")).toBe(SEL.spokeWithdraw);
    expect(toFunctionSelector("exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))")).toBe(SEL.aeroSwap);
  });

  it("lands on-chain with checker 0 and Day × 1, and packs the limits for the executor's register", () => {
    const p = sellPermission({ account, spender: executor, start: 1, end: 2, salt: 7n, capRaw: 5_000_000n, limitsRaw: limits });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.unit, s.multiplier])).toEqual(p.spends.map(() => [PERIOD.Day, 1]));
    expect(stockTerms(limits)).toBe((25_000n << 160n) | (10_000n << 192n));
  });

  it("refuses a grant that sells nothing, or limits that aren't whole units of 1e-4 share", () => {
    expect(() => sellGrant(5_000_000n, limits.map(() => 0n))).toThrow(/at least one/);
    expect(() => sellGrant(5_000_000n, limits.map((l) => (l ? l + 1n : 0n)))).toThrow(/whole units/);
    expect(() => sellGrant(0n, limits)).toThrow(/positive/);
  });
});

describe("rebalanceGrant (the Rebalancer, its own JAW grant)", () => {
  // NVIDIA and Tesla it may sell, with weekly limits; the other five it may only buy into the mix.
  const limits = EQUITIES.map((e) => (e.symbol === "NVDAc" ? 250_000_000n : e.symbol === "TSLAc" ? 100_000_000n : 0n));
  const nvda = EQUITIES[5].address;
  const tsla = EQUITIES[6].address;

  it("may approve the stocks it may sell and USDC to Aerodrome's router, and swap: no Aave call at all", () => {
    expect(rebalanceGrant(500_000_000n, limits)).toEqual({
      calls: [
        { target: nvda, selector: SEL.approve },
        { target: tsla, selector: SEL.approve },
        { target: USDC.address, selector: SEL.approve },
        { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
      ],
      spends: [
        { token: USDC.address, allowance: "500000000", unit: "week" },
        { token: nvda, allowance: "250000000", unit: "week" },
        { token: tsla, allowance: "100000000", unit: "week" },
      ],
    });
  });

  it("lands on-chain with checker 0 and Week × 1, and packs the limits like Protect · sell's", () => {
    const p = rebalancePermission({ account, spender: executor, start: 1, end: 2, salt: 7n, capRaw: 500_000_000n, limitsRaw: limits });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.unit, s.multiplier])).toEqual(p.spends.map(() => [PERIOD.Week, 1]));
    expect(stockTerms(limits)).toBe((25_000n << 160n) | (10_000n << 192n));
  });

  it("refuses a grant that may sell nothing, or a zero limit", () => {
    expect(() => rebalanceGrant(500_000_000n, limits.map(() => 0n))).toThrow(/Rebalancer needs at least one/);
    expect(() => rebalanceGrant(0n, limits)).toThrow(/positive/);
  });
});

describe("entryGrant (the Entry agent on Base, its own JAW grant)", () => {
  it("may approve each coin and swap it at its venue, with a daily limit per coin at the same face value", () => {
    expect(entryGrant(1_000_000_000n)).toEqual({
      calls: [
        ...ENTRY_COINS.map((c) => ({ target: c.address, selector: SEL.approve })),
        { target: AERODROME_V1.ROUTER, selector: SEL.aeroSwap },
        { target: UNISWAP.SWAP_ROUTER_02, selector: SEL.uniSwap },
        { target: SPARK_PSM3.PSM3, selector: SEL.psmSwap },
      ],
      spends: [
        { token: ENTRY_COINS[0].address, allowance: "1000000000", unit: "day" },
        { token: ENTRY_COINS[1].address, allowance: "1000000000000000000000", unit: "day" },
        { token: ENTRY_COINS[2].address, allowance: "1000000000", unit: "day" },
        { token: ENTRY_COINS[3].address, allowance: "1000000000000000000000", unit: "day" },
      ],
    });
  });

  it("uses the selectors the deployed venues expose, and lands on-chain with checker 0 and Day × 1", () => {
    expect(toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")).toBe(SEL.uniSwap);
    expect(toFunctionSelector("swapExactIn(address,address,uint256,uint256,address,uint256)")).toBe(SEL.psmSwap);
    const p = entryPermission({ account, spender: executor, start: 1, end: 2, salt: 7n, capRaw: 1_000_000_000n });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.unit, s.multiplier])).toEqual(p.spends.map(() => [PERIOD.Day, 1]));
    expect(() => entryGrant(0n)).toThrow(/positive/);
  });
});

describe("readAgentGrant (JAW's usePermissions listing)", () => {
  /** A listing as JAW's relay stores a grant: lowercase-insensitive addresses, hex allowance and salt. */
  const listed = (job: "save" | "protect", over: Partial<ListedPermission> = {}): ListedPermission => {
    const grant = agentGrant(job, 5_000_000n);
    return {
      permissionId: "0x" + "ab".repeat(32),
      spender: executor.toLowerCase(),
      start: 100,
      end: 200,
      salt: toHex(12345n),
      calls: grant.calls!.map((c) => ({ target: c.target.toLowerCase(), selector: c.selector!, checker: zeroAddress })),
      spends: grant.spends!.map((s) => ({ token: s.token.toLowerCase(), allowance: toHex(BigInt(s.allowance)), unit: "day", multiplier: 1 })),
      ...over,
    };
  };

  it("reads our grants: job, limit, window and salt", () => {
    expect(readAgentGrant(listed("save"), executor)).toEqual({
      job: "save",
      permissionId: "0x" + "ab".repeat(32),
      capRaw: 5_000_000n,
      start: 100,
      end: 200,
      salt: 12345n,
    });
    expect(readAgentGrant(listed("protect"), executor)?.job).toBe("protect");
  });

  it("ignores anyone else's spender and anything that isn't exactly a job's template", () => {
    expect(readAgentGrant(listed("save", { spender: account }), executor)).toBeNull();
    const p = listed("protect");
    expect(readAgentGrant({ ...p, calls: p.calls.slice(0, 2) }, executor)).toBeNull();
    expect(readAgentGrant({ ...p, calls: p.calls.map((c, i) => (i === 2 ? { ...c, checker: account } : c)) }, executor)).toBeNull();
    expect(readAgentGrant({ ...p, spends: [p.spends[0], { ...p.spends[1], allowance: toHex(4_000_000n) }] }, executor)).toBeNull();
    expect(readAgentGrant({ ...p, spends: p.spends.map((s) => ({ ...s, unit: "week" })) }, executor)).toBeNull();
    expect(readAgentGrant({ ...p, spends: [p.spends[0]] }, executor)).toBeNull();
  });
});

describe("contracts/test/vectors", () => {
  it("are what scripts/agent-vectors.ts exports today (run npm run contracts:vectors after changing a rule)", () => {
    for (const [name, data] of Object.entries(agentVectors())) {
      const committed = JSON.parse(readFileSync(new URL(`../../contracts/test/vectors/${name}`, import.meta.url), "utf8"));
      expect(committed, name).toEqual(JSON.parse(JSON.stringify(data)));
    }
  });
});

describe("jobStatus", () => {
  const stored = { start: 100, end: 1_000, cap: 5_000_000n };
  const empty = { start: 0, end: 0, cap: 0n };
  const grant = { job: "save" as const, permissionId: "0x01" as const, capRaw: 5_000_000n, start: 100, end: 1_000, salt: 1n };

  it("is on while the executor runs the grant JAW still lists", () => {
    expect(jobStatus("save", [1, stored, empty], [grant], 500, false)).toBe("on");
  });
  it("is starting between JAW's grant and the executor's registration", () => {
    expect(jobStatus("save", [0, empty, empty], [grant], 500, false)).toBe("starting");
    expect(jobStatus("save", [1, { ...stored, start: 50 }, empty], [grant], 500, false)).toBe("starting"); // a newer grant
  });
  it("is off at once after a revoke, before the registry catches up", () => {
    expect(jobStatus("save", [1, stored, empty], [], 500, false)).toBe("off");
  });
  it("is off past the grant's end, and per job", () => {
    expect(jobStatus("save", [1, stored, empty], [grant], 1_001, false)).toBe("off");
    expect(jobStatus("protect", [1, stored, empty], [grant], 500, false)).toBe("off");
  });
  it("trusts the registry when JAW's list can't be read", () => {
    expect(jobStatus("save", [1, stored, empty], [], 500, true)).toBe("on");
  });
});

describe("dailyLimitRaw (the limit a switch turns a job on with)", () => {
  it("is the boards' $300 a day for Protection and $1,000 for Save", () => {
    expect(dailyLimitRaw("protect", 10n ** 12n)).toBe(300_000_000n);
    expect(dailyLimitRaw("save", 10n ** 12n)).toBe(1_000_000_000n);
  });

  it("never asks for more than the executor's CAP_MAX, so a $5 test deploy registers the grant", () => {
    expect(dailyLimitRaw("protect", 5_000_000n)).toBe(5_000_000n);
    expect(dailyLimitRaw("save", 5_000_000n)).toBe(5_000_000n);
  });
});

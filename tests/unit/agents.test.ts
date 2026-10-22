import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maxUint160, toFunctionSelector, toHex, zeroAddress } from "viem";
import type { PermissionsDetail } from "@jaw.id/wagmi";
import {
  agentGrant,
  agentPermission,
  entryGrant,
  entryPermission,
  jobGrant,
  NO_LIMIT,
  readAgentGrant,
  readStockLimits,
  grantPermission,
  rebalanceGrant,
  rebalancePermission,
  sellGrant,
  sellPermission,
  stockLimitsRaw,
  type ListedPermission,
} from "@/lib/agents/permissions";
import { jobStatus } from "@/lib/agents/status";
import { PERIOD } from "@/lib/agents/permissions";
import { PROTOCOLS, SEL } from "@/lib/protocols/config";
import { AAVE } from "@/lib/aave/addresses";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { CASH_COINS } from "@/lib/tokens/stables";
import { agentVectors } from "@/scripts/agent-vectors";

const guard = "0x00000000000000000000000000000000000E5EC0" as const;
const account = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const MAX = maxUint160.toString();
const signed = { account, spender: guard, start: 1, end: 2, salt: 7n };

describe("NO_LIMIT (decision 9: no limit anywhere, the live test included)", () => {
  it("is the largest a JAW spend holds", () => {
    expect(NO_LIMIT).toBe(maxUint160);
  });
});

describe("agentGrant (what the app sends to JAW's useGrantPermissions)", () => {
  it("Save may approve USDC and supply to the savings pool, a USDC spend a day with no limit", () => {
    expect(agentGrant("save")).toEqual({
      calls: [
        { target: USDC.address, selector: SEL.approve },
        { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.supply },
      ],
      spends: [{ token: USDC.address, allowance: MAX, unit: "day" }],
    });
  });

  it("Protect may withdraw savings, approve USDC and repay, with no limit on USDC or on savings", () => {
    expect(agentGrant("protect")).toEqual({
      calls: [
        { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.withdraw },
        { target: USDC.address, selector: SEL.approve },
        { target: AAVE.SPOKE, selector: SEL.repay },
      ],
      spends: [
        { token: USDC.address, allowance: MAX, unit: "day" },
        { token: PROTOCOLS.AUSDC, allowance: MAX, unit: "day" },
      ],
    });
  });

  it("lands on-chain with checker 0 and Day × 1, in the same order (JAW's apiPermissionsToPermission)", () => {
    const p = agentPermission("protect", signed);
    expect(p.calls.map((c) => [c.target, c.selector, c.checker])).toEqual(
      agentGrant("protect").calls!.map((c) => [c.target, c.selector, zeroAddress]),
    );
    expect(p.spends).toEqual([
      { token: USDC.address, allowance: NO_LIMIT, unit: PERIOD.Day, multiplier: 1 },
      { token: PROTOCOLS.AUSDC, allowance: NO_LIMIT, unit: PERIOD.Day, multiplier: 1 },
    ]);
  });
});

describe("sellGrant (Protect · sell, its own JAW grant)", () => {
  // NVIDIA and Tesla for sale, the other five never.
  const limits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "NVDAc" || e.symbol === "TSLAc"));
  const nvda = EQUITIES[5].address;
  const tsla = EQUITIES[6].address;

  it("may take stock out of Aave, approve the stocks for sale, swap, approve USDC, repay and refresh the account", () => {
    expect(sellGrant(limits)).toEqual({
      calls: [
        { target: AAVE.SPOKE, selector: SEL.spokeWithdraw },
        { target: nvda, selector: SEL.approve },
        { target: tsla, selector: SEL.approve },
        { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
        { target: USDC.address, selector: SEL.approve },
        { target: AAVE.SPOKE, selector: SEL.repay },
        // GooseGuard's REFRESH: only the account or a manager it approved may (step0-facts.md, fact 5).
        { target: AAVE.SPOKE, selector: SEL.spokeRefresh },
      ],
      spends: [
        { token: USDC.address, allowance: MAX, unit: "day" },
        { token: PROTOCOLS.AUSDC, allowance: MAX, unit: "day" },
        { token: nvda, allowance: MAX, unit: "day" },
        { token: tsla, allowance: MAX, unit: "day" },
      ],
    });
  });

  it("uses the selectors the deployed spoke and router expose", () => {
    expect(toFunctionSelector("withdraw(uint256,uint256,address)")).toBe(SEL.spokeWithdraw);
    expect(toFunctionSelector("updateUserDynamicConfig(address)")).toBe(SEL.spokeRefresh);
    expect(SEL.spokeRefresh).toBe("0x826002e2");
    expect(
      toFunctionSelector("exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"),
    ).toBe(SEL.aeroSwap);
  });

  it("lands on-chain with checker 0 and Day × 1", () => {
    const p = sellPermission({ ...signed, limitsRaw: limits });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.allowance, s.unit, s.multiplier])).toEqual(
      p.spends.map(() => [NO_LIMIT, PERIOD.Day, 1]),
    );
  });

  it("refuses a grant that sells nothing, or a stock with an amount limit", () => {
    expect(() => sellGrant(limits.map(() => 0n))).toThrow(/at least one/);
    expect(() => sellGrant(limits.map((l) => (l ? 100_000_000n : 0n)))).toThrow(/no limit/);
  });
});

describe("rebalanceGrant (the Rebalancer, its own JAW grant)", () => {
  // NVIDIA and Tesla it may sell; the other five it may only buy into the mix.
  const limits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "NVDAc" || e.symbol === "TSLAc"));
  const nvda = EQUITIES[5].address;
  const tsla = EQUITIES[6].address;

  it("may approve the stocks it may sell and USDC to Aerodrome's router, and swap: no Aave call, no savings", () => {
    expect(rebalanceGrant(limits)).toEqual({
      calls: [
        { target: nvda, selector: SEL.approve },
        { target: tsla, selector: SEL.approve },
        { target: USDC.address, selector: SEL.approve },
        { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
      ],
      spends: [
        { token: USDC.address, allowance: MAX, unit: "week" },
        { token: nvda, allowance: MAX, unit: "week" },
        { token: tsla, allowance: MAX, unit: "week" },
      ],
    });
    // Decision 1, the wallet rule: no savings withdraw and no aUSDC spend, top-ups or not.
    const g = rebalanceGrant(limits);
    expect(g.calls!.some((c) => c.target === PROTOCOLS.AAVE_V3_POOL)).toBe(false);
    expect(g.spends!.some((s) => s.token === PROTOCOLS.AUSDC)).toBe(false);
  });

  it("lands on-chain with checker 0 and Week × 1", () => {
    const p = rebalancePermission({ ...signed, limitsRaw: limits });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.allowance, s.unit, s.multiplier])).toEqual(
      p.spends.map(() => [NO_LIMIT, PERIOD.Week, 1]),
    );
  });

  it("refuses a grant that may sell nothing", () => {
    expect(() => rebalanceGrant(limits.map(() => 0n))).toThrow(/Rebalancer needs at least one/);
  });
});

describe("entryGrant (Turn into cash on its own, its own JAW grant)", () => {
  it("may approve each coin of CASH_COINS and swap it at the three venues, a spend a day per coin with no limit", () => {
    expect(CASH_COINS.map((c) => c.symbol)).toEqual(["USDT", "USDe", "USDS", "DAI", "EURC"]);
    expect(entryGrant()).toEqual({
      calls: [
        ...CASH_COINS.map((c) => ({ target: c.address, selector: SEL.approve })),
        { target: AERODROME_V1.ROUTER, selector: SEL.aeroSwap },
        { target: UNISWAP.SWAP_ROUTER_02, selector: SEL.uniSwap },
        { target: SPARK_PSM3.PSM3, selector: SEL.psmSwap },
      ],
      spends: CASH_COINS.map((c) => ({ token: c.address, allowance: MAX, unit: "day" })),
    });
  });

  it("uses the selectors the deployed venues expose, and lands on-chain with checker 0 and Day × 1", () => {
    expect(toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")).toBe(
      SEL.uniSwap,
    );
    expect(toFunctionSelector("swapExactIn(address,address,uint256,uint256,address,uint256)")).toBe(SEL.psmSwap);
    const p = entryPermission(signed);
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.allowance, s.unit, s.multiplier])).toEqual(
      p.spends.map(() => [NO_LIMIT, PERIOD.Day, 1]),
    );
  });
});

/** A listing as JAW's relay stores a grant: lowercase-insensitive addresses, hex allowance and salt. */
const listing = (grant: PermissionsDetail, over: Partial<ListedPermission> = {}): ListedPermission => ({
  permissionId: "0x" + "ab".repeat(32),
  spender: guard.toLowerCase(),
  start: 100,
  end: 200,
  salt: toHex(12345n),
  calls: grant.calls!.map((c) => ({ target: c.target.toLowerCase(), selector: c.selector!, checker: zeroAddress })),
  spends: grant.spends!.map((s) => ({
    token: s.token.toLowerCase(),
    allowance: toHex(BigInt(s.allowance)),
    unit: s.unit,
    multiplier: 1,
  })),
  ...over,
});

describe("readAgentGrant (JAW's usePermissions listing, and the allowlist's template check)", () => {
  // Protect may sell NVIDIA and Tesla; the Rebalancer may sell Apple.
  const sellLimits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "NVDAc" || e.symbol === "TSLAc"));
  const rebalanceLimits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "AAPLc"));

  it("reads our grants: job, window and salt", () => {
    expect(readAgentGrant(listing(agentGrant("save")), guard)).toEqual({
      job: "save",
      permissionId: "0x" + "ab".repeat(32),
      start: 100,
      end: 200,
      salt: 12345n,
    });
    expect(readAgentGrant(listing(agentGrant("protect")), guard)?.job).toBe("protect");
    expect(readAgentGrant(listing(entryGrant()), guard)?.job).toBe("entry");
    expect(readAgentGrant(listing(sellGrant(sellLimits)), guard)).toMatchObject({ job: "sell", limitsRaw: sellLimits });
    expect(readAgentGrant(listing(rebalanceGrant(rebalanceLimits)), guard)).toMatchObject({
      job: "rebalance",
      limitsRaw: rebalanceLimits,
    });
  });

  it("ignores anyone else's spender and anything that isn't exactly a job's template", () => {
    expect(readAgentGrant(listing(agentGrant("save"), { spender: account }), guard)).toBeNull();
    const p = listing(agentGrant("protect"));
    expect(readAgentGrant({ ...p, calls: p.calls.slice(0, 2) }, guard)).toBeNull();
    expect(
      readAgentGrant({ ...p, calls: p.calls.map((c, i) => (i === 2 ? { ...c, checker: account } : c)) }, guard),
    ).toBeNull();
    expect(readAgentGrant({ ...p, spends: p.spends.map((s) => ({ ...s, unit: "week" })) }, guard)).toBeNull();
    expect(readAgentGrant({ ...p, spends: [p.spends[0]] }, guard)).toBeNull();
    // A sale whose stock has no approve, a stock approved twice, a sale grant without the refresh.
    const sale = listing(sellGrant(sellLimits));
    expect(readAgentGrant({ ...sale, calls: sale.calls.filter((_, i) => i !== 1) }, guard)).toBeNull();
    expect(readAgentGrant({ ...sale, spends: [...sale.spends.slice(0, 3), sale.spends[2]] }, guard)).toBeNull();
    expect(readAgentGrant({ ...sale, calls: sale.calls.slice(0, -1) }, guard)).toBeNull();
    // The Rebalancer's spends are a week's: a day's is no template.
    const mix = listing(rebalanceGrant(rebalanceLimits));
    expect(readAgentGrant({ ...mix, spends: mix.spends.map((s) => ({ ...s, unit: "day" })) }, guard)).toBeNull();
  });

  it("refuses any allowance under NO_LIMIT, on any job (decision 9), and the old Rebalancer with top-ups", () => {
    for (const grant of [
      agentGrant("save"),
      agentGrant("protect"),
      sellGrant(sellLimits),
      rebalanceGrant(rebalanceLimits),
      entryGrant(),
    ]) {
      const p = listing(grant);
      for (let i = 0; i < p.spends.length; i++) {
        const capped = { ...p, spends: p.spends.map((s, k) => (k === i ? { ...s, allowance: toHex(5_000_000n) } : s)) };
        expect(readAgentGrant(capped, guard)).toBeNull();
      }
    }
    // GooseExecutor's Rebalancer with top-ups: the savings withdraw and aUSDC after USDC.
    const mix = listing(rebalanceGrant(rebalanceLimits));
    const old = {
      ...mix,
      calls: [{ target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.withdraw, checker: zeroAddress }, ...mix.calls],
      spends: [mix.spends[0], { ...mix.spends[0], token: PROTOCOLS.AUSDC }, ...mix.spends.slice(1)],
    };
    expect(readAgentGrant(old, guard)).toBeNull();
  });
});

describe("jobGrant and grantPermission (one entry point for every job's JAW grant)", () => {
  const limits = stockLimitsRaw(EQUITIES.map((_, r) => r === 5));

  it("builds each job's template, and asks for the stocks where the job sells stock", () => {
    expect(jobGrant("save")).toEqual(agentGrant("save"));
    expect(jobGrant("entry")).toEqual(entryGrant());
    expect(jobGrant("sell", limits)).toEqual(sellGrant(limits));
    expect(jobGrant("rebalance", limits)).toEqual(rebalanceGrant(limits));
    expect(() => jobGrant("rebalance")).toThrow(/One entry per stock/);
  });

  it("rebuilds the exact struct the manager approved from a listing", () => {
    const g = readAgentGrant(listing(rebalanceGrant(limits)), guard)!;
    expect(grantPermission(g, account, guard)).toEqual(
      rebalancePermission({ account, spender: guard, start: 100, end: 200, salt: 12345n, limitsRaw: limits }),
    );
  });
});

describe("stockLimitsRaw (the stocks a grant may sell)", () => {
  it("gives each stock it may sell NO_LIMIT and the rest 0, so the grant has no approve for them", () => {
    const l = stockLimitsRaw(EQUITIES.map((e) => e.symbol !== "AAPLc"));
    expect(l[0]).toBe(0n);
    expect(l.slice(1).every((x) => x === NO_LIMIT)).toBe(true);
    expect(sellGrant(l).calls!.some((c) => c.target === EQUITIES[0].address)).toBe(false);
  });

  it("reads back from a grant's spends (readStockLimits)", () => {
    const l = stockLimitsRaw(EQUITIES.map((e) => e.symbol !== "METAc"));
    expect(readStockLimits("sell", sellGrant(l).spends!)).toEqual(l);
    expect(readStockLimits("rebalance", rebalanceGrant(l).spends!)).toEqual(l);
    const withAusdcLast = [...rebalanceGrant(l).spends!, { token: PROTOCOLS.AUSDC, allowance: "1" }];
    expect(readStockLimits("rebalance", withAusdcLast)).toBeNull(); // aUSDC anywhere else isn't a stock
  });
});

describe("contracts/test/vectors", () => {
  it("are what scripts/agent-vectors.ts exports today (run npm run contracts:vectors after changing a rule)", () => {
    for (const [name, data] of Object.entries(agentVectors())) {
      const committed = JSON.parse(
        readFileSync(new URL(`../../contracts/test/vectors/${name}`, import.meta.url), "utf8"),
      );
      expect(committed, name).toEqual(JSON.parse(JSON.stringify(data)));
    }
    // Building every vector takes about 5 s, close to vitest's default limit when the suite runs in parallel.
  }, 30_000);
});

describe("jobStatus", () => {
  const stored = { start: 100, end: 1_000, salt: 1n };
  const empty = { start: 0, end: 0, salt: 0n };
  const grant = {
    job: "save" as const,
    permissionId: "0x01" as const,
    start: 100,
    end: 1_000,
    salt: 1n,
  };

  it("is on while the Guard runs the grant JAW still lists", () => {
    expect(jobStatus("save", 1, stored, [grant], 500, false)).toBe("on");
  });
  it("is starting between JAW's grant and the Guard's registration", () => {
    expect(jobStatus("save", 0, empty, [grant], 500, false)).toBe("starting");
    expect(jobStatus("save", 1, { ...stored, start: 50 }, [grant], 500, false)).toBe("starting"); // a newer grant
  });
  it("is off at once after a revoke, before the Guard catches up", () => {
    expect(jobStatus("save", 1, stored, [], 500, false)).toBe("off");
  });
  it("is off past the grant's end, and per job", () => {
    expect(jobStatus("save", 1, stored, [grant], 1_001, false)).toBe("off");
    expect(jobStatus("protect", 1, empty, [grant], 500, false)).toBe("off");
  });
  it("reads each job's own bit, the Rebalancer's at 1 << 3", () => {
    const rebalance = { ...grant, job: "rebalance" as const };
    expect(jobStatus("rebalance", 1 << 3, stored, [rebalance], 500, false)).toBe("on");
    // Not its bit: the grant the Guard kept is off; only a newer listed one waits to start.
    expect(jobStatus("rebalance", 1 << 2, stored, [rebalance], 500, false)).toBe("off");
    expect(jobStatus("rebalance", 1 << 2, stored, [{ ...rebalance, start: rebalance.start + 1 }], 500, false)).toBe(
      "starting",
    );
  });
  it("trusts the Guard when JAW's list can't be read", () => {
    expect(jobStatus("save", 1, stored, [], 500, true)).toBe("on");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maxUint160, toFunctionSelector, toHex, zeroAddress } from "viem";
import type { PermissionsDetail } from "@jaw.id/wagmi";
import {
  agentGrant,
  agentPermission,
  entryGrant,
  entryPermission,
  hasLimit,
  jobGrant,
  LIMIT_USD,
  limitRaw,
  NO_LIMIT_JOBS,
  readAgentGrant,
  readStockLimits,
  rebalanceGrant,
  rebalancePermission,
  sellGrant,
  sellPermission,
  startCapRaw,
  stockLimitsRaw,
  stockTerms,
  type ListedPermission,
} from "@/lib/agents/permissions";
import { jobStatus } from "@/lib/agents/status";
import { PERIOD } from "@/lib/agents/permissions";
import { PROTOCOLS, SEL } from "@/lib/protocols/config";
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
        { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.supply },
      ],
      spends: [{ token: USDC.address, allowance: "5000000", unit: "day" }],
    });
  });

  it("Protect may withdraw savings, approve USDC and repay, with the same daily limit on USDC and on savings", () => {
    expect(agentGrant("protect", 5_000_000n)).toEqual({
      calls: [
        { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.withdraw },
        { target: USDC.address, selector: SEL.approve },
        { target: AAVE.SPOKE, selector: SEL.repay },
      ],
      spends: [
        { token: USDC.address, allowance: "5000000", unit: "day" },
        { token: PROTOCOLS.AUSDC, allowance: "5000000", unit: "day" },
      ],
    });
  });

  it("refuses a zero limit", () => {
    expect(() => agentGrant("save", 0n)).toThrow(/positive/);
  });

  it("lands on-chain with checker 0 and Day × 1, in the same order (JAW's apiPermissionsToPermission)", () => {
    const p = agentPermission("protect", {
      account,
      spender: executor,
      start: 1,
      end: 2,
      salt: 7n,
      capRaw: 5_000_000n,
    });
    expect(p.calls.map((c) => [c.target, c.selector, c.checker])).toEqual(
      agentGrant("protect", 5_000_000n).calls!.map((c) => [c.target, c.selector, zeroAddress]),
    );
    expect(p.spends).toEqual([
      { token: USDC.address, allowance: 5_000_000n, unit: PERIOD.Day, multiplier: 1 },
      { token: PROTOCOLS.AUSDC, allowance: 5_000_000n, unit: PERIOD.Day, multiplier: 1 },
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
        { token: PROTOCOLS.AUSDC, allowance: "5000000", unit: "day" },
        { token: nvda, allowance: "250000000", unit: "day" },
        { token: tsla, allowance: "100000000", unit: "day" },
      ],
    });
  });

  it("uses the selectors the deployed spoke and router expose", () => {
    expect(toFunctionSelector("withdraw(uint256,uint256,address)")).toBe(SEL.spokeWithdraw);
    expect(
      toFunctionSelector("exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"),
    ).toBe(SEL.aeroSwap);
  });

  it("lands on-chain with checker 0 and Day × 1, and packs the limits for the executor's register", () => {
    const p = sellPermission({
      account,
      spender: executor,
      start: 1,
      end: 2,
      salt: 7n,
      capRaw: 5_000_000n,
      limitsRaw: limits,
    });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.unit, s.multiplier])).toEqual(p.spends.map(() => [PERIOD.Day, 1]));
    expect(stockTerms(limits)).toBe((25_000n << 160n) | (10_000n << 192n));
  });

  it("refuses a grant that sells nothing, or limits that aren't whole units of 1e-4 share", () => {
    expect(() =>
      sellGrant(
        5_000_000n,
        limits.map(() => 0n),
      ),
    ).toThrow(/at least one/);
    expect(() =>
      sellGrant(
        5_000_000n,
        limits.map((l) => (l ? l + 1n : 0n)),
      ),
    ).toThrow(/whole units/);
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
    const p = rebalancePermission({
      account,
      spender: executor,
      start: 1,
      end: 2,
      salt: 7n,
      capRaw: 500_000_000n,
      limitsRaw: limits,
    });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.unit, s.multiplier])).toEqual(p.spends.map(() => [PERIOD.Week, 1]));
    expect(stockTerms(limits)).toBe((25_000n << 160n) | (10_000n << 192n));
  });

  it("refuses a grant that may sell nothing, or a zero limit", () => {
    expect(() =>
      rebalanceGrant(
        500_000_000n,
        limits.map(() => 0n),
      ),
    ).toThrow(/Rebalancer needs at least one/);
    expect(() => rebalanceGrant(0n, limits)).toThrow(/positive/);
  });

  it("with top-ups, may also take savings out first, under an aUSDC limit at the same cap, a week each", () => {
    expect(rebalanceGrant(500_000_000n, limits, true)).toEqual({
      calls: [
        { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.withdraw },
        { target: nvda, selector: SEL.approve },
        { target: tsla, selector: SEL.approve },
        { target: USDC.address, selector: SEL.approve },
        { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
      ],
      spends: [
        { token: USDC.address, allowance: "500000000", unit: "week" },
        { token: PROTOCOLS.AUSDC, allowance: "500000000", unit: "week" },
        { token: nvda, allowance: "250000000", unit: "week" },
        { token: tsla, allowance: "100000000", unit: "week" },
      ],
    });
    const p = rebalancePermission({
      account,
      spender: executor,
      start: 1,
      end: 2,
      salt: 7n,
      capRaw: 500_000_000n,
      limitsRaw: limits,
      topUps: true,
    });
    expect(p.calls[0]).toEqual({ target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.withdraw, checker: zeroAddress });
    expect(p.spends.map((s) => [s.token, s.unit, s.multiplier])).toEqual([
      [USDC.address, PERIOD.Week, 1],
      [PROTOCOLS.AUSDC, PERIOD.Week, 1],
      [nvda, PERIOD.Week, 1],
      [tsla, PERIOD.Week, 1],
    ]);
    expect(rebalancePermission({ ...p, capRaw: 500_000_000n, limitsRaw: limits })).toEqual({
      ...p,
      calls: p.calls.slice(1),
      spends: [p.spends[0], ...p.spends.slice(2)],
    });
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
    expect(toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")).toBe(
      SEL.uniSwap,
    );
    expect(toFunctionSelector("swapExactIn(address,address,uint256,uint256,address,uint256)")).toBe(SEL.psmSwap);
    const p = entryPermission({ account, spender: executor, start: 1, end: 2, salt: 7n, capRaw: 1_000_000_000n });
    expect(p.calls.every((c) => c.checker === zeroAddress)).toBe(true);
    expect(p.spends.map((s) => [s.unit, s.multiplier])).toEqual(p.spends.map(() => [PERIOD.Day, 1]));
    expect(() => entryGrant(0n)).toThrow(/positive/);
  });
});

describe("readAgentGrant (JAW's usePermissions listing)", () => {
  /** A listing as JAW's relay stores a grant: lowercase-insensitive addresses, hex allowance and salt. */
  const listing = (grant: PermissionsDetail, over: Partial<ListedPermission> = {}): ListedPermission => ({
    permissionId: "0x" + "ab".repeat(32),
    spender: executor.toLowerCase(),
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
  const listed = (job: "save" | "protect", over: Partial<ListedPermission> = {}) =>
    listing(agentGrant(job, 5_000_000n), over);
  // Protect may sell NVIDIA and Tesla; the Rebalancer may sell Apple.
  const sellLimits = EQUITIES.map((e) =>
    e.symbol === "NVDAc" ? 250_000_000n : e.symbol === "TSLAc" ? 100_000_000n : 0n,
  );
  const rebalanceLimits = EQUITIES.map((e) => (e.symbol === "AAPLc" ? 50_000_000n : 0n));

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
    expect(
      readAgentGrant({ ...p, calls: p.calls.map((c, i) => (i === 2 ? { ...c, checker: account } : c)) }, executor),
    ).toBeNull();
    expect(
      readAgentGrant({ ...p, spends: [p.spends[0], { ...p.spends[1], allowance: toHex(4_000_000n) }] }, executor),
    ).toBeNull();
    expect(readAgentGrant({ ...p, spends: p.spends.map((s) => ({ ...s, unit: "week" })) }, executor)).toBeNull();
    expect(readAgentGrant({ ...p, spends: [p.spends[0]] }, executor)).toBeNull();
    // A sale whose stock limit has no approve, or a stock approved twice.
    const sale = listing(sellGrant(300_000_000n, sellLimits));
    expect(readAgentGrant({ ...sale, calls: sale.calls.filter((_, i) => i !== 1) }, executor)).toBeNull();
    expect(readAgentGrant({ ...sale, spends: [...sale.spends.slice(0, 3), sale.spends[2]] }, executor)).toBeNull();
    // The Rebalancer's limits are a week's: a day's is no template.
    const mix = listing(rebalanceGrant(500_000_000n, rebalanceLimits));
    expect(readAgentGrant({ ...mix, spends: mix.spends.map((s) => ({ ...s, unit: "day" })) }, executor)).toBeNull();
  });
});

describe("readAgentGrant for the jobs that sell stock and for Entry", () => {
  /** A listing of `grant` as JAW's relay stores it. */
  const listedOf = (grant: PermissionsDetail, over: Partial<ListedPermission> = {}): ListedPermission => ({
    permissionId: "0x" + "cd".repeat(32),
    spender: executor,
    start: 100,
    end: 200,
    salt: toHex(7n),
    calls: grant.calls!.map((c) => ({ target: c.target, selector: c.selector!, checker: zeroAddress })),
    spends: grant.spends!.map((s) => ({
      token: s.token,
      allowance: toHex(BigInt(s.allowance)),
      unit: s.unit,
      multiplier: 1,
    })),
    ...over,
  });
  // Apple and Tesla may be sold; the rest are never sold.
  const limits = EQUITIES.map((e) => (e.symbol === "AAPLc" ? 30_000n : e.symbol === "TSLAc" ? 50_000n : 0n));

  it("reads Protect · sell with its stock limits, a never-sell stock at 0", () => {
    expect(readAgentGrant(listedOf(sellGrant(300_000_000n, limits)), executor)).toMatchObject({
      job: "sell",
      capRaw: 300_000_000n,
      limitsRaw: limits,
    });
  });

  it("reads the Rebalancer, weekly, with its stock limits", () => {
    expect(readAgentGrant(listedOf(rebalanceGrant(500_000_000n, limits)), executor)).toMatchObject({
      job: "rebalance",
      capRaw: 500_000_000n,
      limitsRaw: limits,
    });
  });

  it("reads Entry, its limit in USDC units", () => {
    expect(readAgentGrant(listedOf(entryGrant(1_000_000_000n)), executor)).toMatchObject({
      job: "entry",
      capRaw: 1_000_000_000n,
    });
  });

  it("refuses a sale grant that doesn't match its own stocks: an approve without a limit, a limit off the unit", () => {
    const p = listedOf(sellGrant(300_000_000n, limits));
    expect(readAgentGrant({ ...p, spends: p.spends.slice(0, -1) }, executor)).toBeNull();
    expect(
      readAgentGrant(
        { ...p, spends: p.spends.map((x, i) => (i === 2 ? { ...x, allowance: toHex(30_001n) } : x)) },
        executor,
      ),
    ).toBeNull();
    expect(readAgentGrant({ ...p, spends: p.spends.map((x) => ({ ...x, unit: "week" })) }, executor)).toBeNull();
  });
});

describe("jobGrant (one entry point for every job's JAW grant)", () => {
  it("builds each job's template, and asks for stock limits where the job sells stock", () => {
    const limits = EQUITIES.map((_, r) => (r === 5 ? 10_000n : 0n));
    expect(jobGrant("save", 1n)).toEqual(agentGrant("save", 1n));
    expect(jobGrant("entry", 1n)).toEqual(entryGrant(1n));
    expect(jobGrant("sell", 1n, limits)).toEqual(sellGrant(1n, limits));
    expect(jobGrant("rebalance", 1n, limits)).toEqual(rebalanceGrant(1n, limits));
    expect(() => jobGrant("rebalance", 1n)).toThrow(/One limit per stock/);
  });
});

describe("stockLimitsRaw (a grant's limit per stock, from its dollar limit)", () => {
  const prices = EQUITIES.map(() => 200n * 10n ** 8n); // $200 a share
  const all = EQUITIES.map(() => true);

  it("is shares worth twice the dollar limit, in whole units of 1e-4 share", () => {
    const l = stockLimitsRaw(300_000_000n, 10n ** 12n, prices, all);
    expect(l.every((x) => x === 300_000_000n)).toBe(true); // $600 / $200 = 3 shares
    expect(
      stockLimitsRaw(
        1_000_000n,
        10n ** 12n,
        EQUITIES.map(() => 30_000_000_000n),
        all,
      )[0],
    ).toBe(660_000n); // $2 / $300 = 0.00667 share, rounded down to 0.0066
  });

  it("stays 1% under the executor's bound of twice CAP_MAX, so registration takes it", () => {
    const l = stockLimitsRaw(5_000_000n, 5_000_000n, prices, all); // a $5 test deploy (D13)
    expect((l[0] * prices[0]) / 10n ** 10n).toBeLessThanOrEqual(9_900_000n);
    expect(stockTerms(l)).toBeGreaterThan(0n);
  });

  it("gives a stock it may not sell 0, so the grant has no approve for it", () => {
    const l = stockLimitsRaw(
      300_000_000n,
      10n ** 12n,
      prices,
      EQUITIES.map((e) => e.symbol !== "AAPLc"),
    );
    expect(l[0]).toBe(0n);
    expect(sellGrant(300_000_000n, l).calls!.some((c) => c.target === EQUITIES[0].address)).toBe(false);
  });

  it("starts a Rebalancer grant at CAP_MAX, with each stock at the clamp on a deploy with no amount limit", () => {
    const cap = startCapRaw("rebalance", maxUint160);
    const l = stockLimitsRaw(cap, maxUint160, prices, all);
    const clamp = (2n ** 32n - 1n) * 10_000n; // 32 bits of 1e-4 share, what the grant's terms hold
    expect(l.every((x) => x === clamp)).toBe(true);
    const spends = rebalanceGrant(cap, l).spends!;
    expect(spends[0]).toEqual({ token: USDC.address, allowance: maxUint160.toString(), unit: "week" });
    expect(spends.slice(1).every((x) => x.allowance === clamp.toString() && x.unit === "week")).toBe(true);
    expect(stockTerms(l)).toBeGreaterThan(0n);
  });

  it("reads back from a grant's spends (readStockLimits)", () => {
    const l = stockLimitsRaw(
      300_000_000n,
      10n ** 12n,
      prices,
      EQUITIES.map((e) => e.symbol !== "METAc"),
    );
    expect(readStockLimits("sell", sellGrant(300_000_000n, l).spends!)).toEqual(l);
    expect(readStockLimits("rebalance", rebalanceGrant(300_000_000n, l).spends!)).toEqual(l);
    expect(readStockLimits("rebalance", sellGrant(300_000_000n, l).spends!)).toBeNull(); // aUSDC isn't a stock
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
  const stored = { start: 100, end: 1_000, cap: 5_000_000n };
  const empty = { start: 0, end: 0, cap: 0n };
  const grant = {
    job: "save" as const,
    permissionId: "0x01" as const,
    capRaw: 5_000_000n,
    start: 100,
    end: 1_000,
    salt: 1n,
  };

  it("is on while the executor runs the grant JAW still lists", () => {
    expect(jobStatus("save", 1, stored, [grant], 500, false)).toBe("on");
  });
  it("is starting between JAW's grant and the executor's registration", () => {
    expect(jobStatus("save", 0, empty, [grant], 500, false)).toBe("starting");
    expect(jobStatus("save", 1, { ...stored, start: 50 }, [grant], 500, false)).toBe("starting"); // a newer grant
  });
  it("is off at once after a revoke, before the registry catches up", () => {
    expect(jobStatus("save", 1, stored, [], 500, false)).toBe("off");
  });
  it("is off past the grant's end, and per job", () => {
    expect(jobStatus("save", 1, stored, [grant], 1_001, false)).toBe("off");
    expect(jobStatus("protect", 1, empty, [grant], 500, false)).toBe("off");
  });
  it("reads each job's own bit, the Rebalancer's at 1 << 3", () => {
    const rebalance = { ...grant, job: "rebalance" as const };
    expect(jobStatus("rebalance", 1 << 3, stored, [rebalance], 500, false)).toBe("on");
    expect(jobStatus("rebalance", 1 << 2, stored, [rebalance], 500, false)).toBe("starting");
  });
  it("trusts the registry when JAW's list can't be read", () => {
    expect(jobStatus("save", 1, stored, [], 500, true)).toBe("on");
  });
});

describe("limitRaw and startCapRaw (the cap a switch turns a job on with)", () => {
  it("starts Save and Entry on $1,000 a day", () => {
    expect(limitRaw(LIMIT_USD.save.start, 10n ** 12n)).toBe(1_000_000_000n);
    expect(limitRaw(LIMIT_USD.entry.start, 10n ** 12n)).toBe(1_000_000_000n);
    expect(startCapRaw("save", 10n ** 12n)).toBe(1_000_000_000n);
  });

  it("gives Protect, selling and the Rebalancer no amount limit: their grants carry the executor's CAP_MAX", () => {
    expect(NO_LIMIT_JOBS).toEqual(["protect", "sell", "rebalance"]);
    expect((["save", "protect", "sell", "rebalance", "entry"] as const).map(hasLimit)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(Object.keys(LIMIT_USD).sort()).toEqual(["entry", "save"]);
    expect(startCapRaw("protect", 10n ** 12n)).toBe(10n ** 12n);
    expect(startCapRaw("sell", 5_000_000n)).toBe(5_000_000n);
    expect(startCapRaw("rebalance", 10n ** 12n)).toBe(10n ** 12n);
    expect(startCapRaw("rebalance", 5_000_000n)).toBe(5_000_000n);
  });

  it("never asks for more than the executor's CAP_MAX, so a $5 test deploy registers the grant", () => {
    expect(limitRaw(LIMIT_USD.save.start, 5_000_000n)).toBe(5_000_000n);
    expect(limitRaw(LIMIT_USD.entry.start, 5_000_000n)).toBe(5_000_000n);
  });
});

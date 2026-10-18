import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { assertAllowed, swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import {
  SELL_BLOCKED,
  buildSaleCalls,
  floorPriceUsd,
  planSell,
  saleActivity,
  saleRepayRaw,
  saleSaveRaw,
  type SellHolding,
  type SellPosition,
} from "@/lib/sell";
import { minOut } from "@/lib/swap/buy";
import type { SellQuote } from "@/lib/swap/sell";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const attacker: `0x${string}` = "0x00000000000000000000000000000000000000ee";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const shares = (n: number) => parseUnits(n.toFixed(8), 8);
const fee = usd(CASH.feeBufferUsd);
const B = CASH.feeBufferUsd;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const price = 250;
/** 0.4 NVDA ($100 at Aave's price) sells for $99.50. */
const quote: SellQuote = { venue: "aerodrome", pool: 10, amountIn: shares(0.4), amountOut: usd(99.5) };
const fn = (data: `0x${string}`) => {
  try {
    return decodeFunctionData({ abi: [...erc20Abi, ...spokeAbi], data }).functionName;
  } catch {
    return decodeFunctionData({ abi: aaveV3PoolAbi, data }).functionName;
  }
};
const steps = (calls: { data: `0x${string}`; to: `0x${string}` }[]) =>
  calls.map((c) => (swapOf(c) ? "swap" : fn(c.data)));

/** $1,000 of NVDA backs the credit (CF 70%); 0.1 NVDA is free. */
const holding: SellHolding = {
  priceUsd: price,
  freeRaw: shares(0.1),
  backingRaw: shares(4),
  backingUsd: 1_000,
  paused: false,
};
const owing = (debtUsd: number): SellPosition => ({
  totalBackingUsd: 1_000,
  avgCf: 0.7,
  debtUsd,
  debtRaw: usd(debtUsd),
  healthFactor: debtUsd > 0 ? 700 / debtUsd : null,
});
const tuesday = new Date("2026-10-13T15:00:00Z");
const plan = (from: "free" | "backing" | "repay", q: SellQuote, position = owing(300), h = holding) =>
  planSell({ from, stock: nvda, holding: h, cf: 0.7, position, quote: q, now: tuesday });

describe("buildSaleCalls", () => {
  const sale = (from: "free" | "backing" | "repay", debtRaw = usd(300), q = quote) =>
    buildSaleCalls({ from, user, stock: nvda, quote: q, oraclePriceUsd: price, debtRaw, nowSec: 1_000 });

  it("a backing holding: take the shares out → approve → swap, the same shares all the way", () => {
    const calls = sale("backing");
    expect(steps(calls)).toEqual(["withdraw", "approve", "swap"]);
    expect(calls[0].to).toBe(AAVE.SPOKE);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[0].data }).args).toEqual([
      BigInt(nvda.reserveId),
      shares(0.4),
      user,
    ]);
    expect(swapOf(calls[2])!.params.amountIn).toBe(shares(0.4));
  });

  it("a sale into cash: approve → swap → approve → supply the floor into savings, for the user", () => {
    const calls = buildSaleCalls({
      from: "free",
      user,
      stock: nvda,
      quote,
      oraclePriceUsd: price,
      debtRaw: 0n,
      walletRaw: fee,
      nowSec: 1_000,
    });
    expect(steps(calls)).toEqual(["approve", "swap", "approve", "supply"]);
    const floor = minOut(usd(99.5));
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([PROTOCOLS.AAVE_V3_POOL, floor]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[3].data }).args).toEqual([
      USDC.address,
      floor,
      user,
      0,
    ]);
  });

  it("a sale into cash keeps back what the wallet lacks for the network fee, and nothing when it has it", () => {
    const floor = minOut(usd(99.5));
    expect(saleSaveRaw(floor, 0n)).toBe(floor - fee);
    expect(saleSaveRaw(floor, fee / 2n)).toBe(floor - fee / 2n);
    expect(saleSaveRaw(floor, usd(5))).toBe(floor);
    expect(saleSaveRaw(fee, 0n)).toBe(0n);
    // Without the wallet read (an older caller), the sale stays as it was.
    expect(steps(sale("free"))).toEqual(["approve", "swap"]);
  });

  it("repay by selling: take out → approve → swap → approve → repay what the swap is sure to pay, less the fee", () => {
    const calls = sale("repay");
    expect(steps(calls)).toEqual(["withdraw", "approve", "swap", "approve", "repay"]);
    const repayRaw = minOut(usd(99.5)) - fee;
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[3].data }).args).toEqual([AAVE.SPOKE, repayRaw]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[4].data }).args).toEqual([
      BigInt(USDC.reserveId),
      repayRaw,
      user,
    ]);
  });

  it("repay by selling more than is owed: a full repay, then the leftover allowance goes back to 0", () => {
    const calls = sale("repay", usd(20));
    expect(steps(calls)).toEqual(["withdraw", "approve", "swap", "approve", "repay", "approve"]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[4].data }).args[1]).toBe(usd(20) + usd(20) / 2000n + 1n);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[5].data }).args).toEqual([AAVE.SPOKE, 0n]);
  });

  it("passes the allowlist for the user only", () => {
    for (const from of ["free", "backing", "repay"] as const) {
      const calls = sale(from);
      expect(assertAllowed(user, calls)).toBe(calls);
      expect(() => assertAllowed(attacker, calls)).toThrow(/unexpected arguments/);
    }
  });

  it("refuses a repay the sale can't pay for", () => {
    // Half the fee buffer's worth of NVIDIA: its floor (the quote less 1%, or Aave's price less 10%) is under the buffer.
    expect(() => sale("repay", usd(300), { ...quote, amountIn: shares(B / 2 / price), amountOut: usd(B / 2) })).toThrow(
      /positive/,
    );
  });
});

describe("saleRepayRaw", () => {
  it("keeps the fee buffer back and repays no more than all of it", () => {
    expect(saleRepayRaw(usd(10), usd(300))).toBe(usd(10) - fee);
    expect(saleRepayRaw(usd(10), usd(2))).toBe(usd(2) + usd(2) / 2000n + 1n);
    expect(saleRepayRaw(fee, usd(300))).toBe(0n);
  });
});

describe("planSell: free shares", () => {
  it("sells what's free, and the credit doesn't change", () => {
    const p = plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24.9) });
    expect(p.block).toBeUndefined();
    expect(p.maxRaw).toBe(shares(0.1));
    expect(p.before).toBe("safe");
    expect(p.after).toBe("safe");
    expect(p.hfAfter).toBeCloseTo(700 / 300, 6);
    expect(p.repayRaw).toBe(0n);
  });

  it("blocks more than the free shares, under a cent, and a pool paying past the floor", () => {
    expect(plan("free", quote).block).toBe("not-free");
    expect(plan("free", { ...quote, amountIn: shares(0.00002), amountOut: usd(0.005) }).block).toBe("too-small");
    expect(plan("free", { ...quote, amountIn: shares(0.002), amountOut: usd(0.5) }).block).toBeUndefined();
    const far = plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(22) });
    expect(far.block).toBe("price");
    expect(SELL_BLOCKED.price).toMatch(/more than 10% under Aave’s price/);
  });

  it("warns past 2% under Aave's price, and says when the price may move", () => {
    expect(plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24) }).warn).toBe(true);
    expect(plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24.9) }).warn).toBe(false);
    expect(plan("free", quote).priceMayMove).toBe(false);
    const saturday = planSell({
      from: "free",
      stock: nvda,
      holding,
      cf: 0.7,
      position: owing(300),
      quote,
      now: new Date("2026-10-17T15:00:00Z"),
    });
    expect(saturday.priceMayMove).toBe(true);
  });
});

describe("planSell: a backing holding (step 3)", () => {
  it("sells only as far as the 1.12 line allows (Act is the line)", () => {
    // room = 700 − 300 × 1.12 = 364 → $520 of NVDA → 2.08 of the 4 shares in use
    const p = plan("backing", quote);
    expect(p.block).toBeUndefined();
    expect(p.maxRaw).toBe((shares(4) * 520_000n) / 1_000_000n);
    expect(p.takeOutRaw).toBe(quote.amountIn);
    expect(p.hfAfter).toBeCloseTo((700 - 70) / 300, 6);
    expect(p.after).toBe("safe");
    const big = plan("backing", { ...quote, amountIn: shares(2.2), amountOut: usd(547) });
    expect(big.block).toBe("past-line");
    expect(SELL_BLOCKED["past-line"]).toMatch(/Repay some first/);
  });

  it("at the line already: nothing can come out", () => {
    const p = plan("backing", quote, owing(625));
    expect(p.before).toBe("watch");
    expect(p.maxRaw).toBe(0n);
    expect(p.block).toBe("past-line");
  });

  it("with nothing owed, all of it can go", () => {
    const p = plan("backing", { ...quote, amountIn: shares(4), amountOut: usd(990) }, owing(0));
    expect(p.maxRaw).toBe(shares(4));
    expect(p.block).toBeUndefined();
    expect(p.after).toBe("none");
  });

  it("blocks more than backs the credit, and a paused stock", () => {
    expect(plan("backing", { ...quote, amountIn: shares(5), amountOut: usd(1_240) }).block).toBe("not-backing");
    expect(plan("backing", quote, owing(300), { ...holding, paused: true }).block).toBe("paused");
  });
});

describe("planSell: repay by selling a holding (step 9)", () => {
  it("in Safe: repays what the sale is sure to pay less the fee, and ends healthier", () => {
    const p = plan("repay", quote);
    expect(p.block).toBeUndefined();
    expect(p.repayRaw).toBe(minOut(usd(99.5)) - fee);
    expect(p.hfAfter!).toBeGreaterThan(700 / 300);
    expect(p.after).toBe("safe");
  });

  it("in Watch: works, and ends healthier", () => {
    const p = plan("repay", quote, owing(560));
    expect(p.before).toBe("watch");
    expect(p.block).toBeUndefined();
    expect(p.hfAfter!).toBeCloseTo((700 - 70) / (560 - Number(p.repayRaw) / 1e6), 6);
    expect(p.hfAfter!).toBeGreaterThan(1.25);
  });

  it("near Aave's limit, the shares can't come out before they repay: blocked with why", () => {
    // HF 1.0145: only (700 − 690) / 0.7 × 0.995 ≈ $14.21 of NVDA can come out first.
    const p = plan("repay", quote, owing(690));
    expect(p.before).toBe("act");
    expect(p.block).toBe("near-limit");
    expect(SELL_BLOCKED["near-limit"]).toMatch(/too close to Aave’s limit/);
    const small = plan("repay", { ...quote, amountIn: shares(0.04), amountOut: usd(9.95) }, owing(690));
    expect(small.block).toBeUndefined();
    expect(small.hfAfter!).toBeGreaterThan(700 / 690);
  });

  it("a small sale that would repay less than its shares back and end in Act is blocked (Act is the line)", async () => {
    // The rule, at a $0.50 buffer (where it was set): $10 owed against 0.063 NVDA ($15.75 at 70%), health 1.1025, in
    // Watch. $1.20 of it repays its floor less $0.50, about $0.68, and takes $0.84 of backing out: about 1.09, in Act.
    vi.resetModules();
    vi.doMock("@/config/risk", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/config/risk")>();
      return { ...actual, CASH: { ...actual.CASH, feeBufferUsd: 0.5 } };
    });
    try {
      const at50 = await import("@/lib/sell");
      const thin: SellPosition = {
        totalBackingUsd: 15.75,
        avgCf: 0.7,
        debtUsd: 10,
        debtRaw: usd(10),
        healthFactor: 1.1025,
      };
      const h: SellHolding = {
        priceUsd: price,
        freeRaw: 0n,
        backingRaw: shares(0.063),
        backingUsd: 15.75,
        paused: false,
      };
      const planAt50 = (q: SellQuote) =>
        at50.planSell({ from: "repay", stock: nvda, holding: h, cf: 0.7, position: thin, quote: q, now: tuesday });
      const p = planAt50({ ...quote, amountIn: shares(0.0048), amountOut: usd(1.194) });
      expect(p.before).toBe("watch");
      expect(p.after).toBe("act");
      expect(p.hfAfter!).toBeLessThan(1.1025);
      expect(p.block).toBe("act");
      expect(at50.SELL_BLOCKED.act).toBe("That would put your credit in Act. Sell more, or repay from cash.");
      // Selling a little more repays enough to stay out of Act (the fee buffer weighs less): it goes ahead, in Watch.
      const more = planAt50({ ...quote, amountIn: shares(0.0056), amountOut: usd(1.393) });
      expect(more.after).toBe("watch");
      expect(more.block).toBeUndefined();
    } finally {
      vi.doUnmock("@/config/risk");
      vi.resetModules();
    }
  });

  it("at today's fee buffer the same $1.20 sale stays in Watch: the fee no longer outweighs the backing it frees", () => {
    // From Watch, a sale of v dollars ends in Act only if v < 1.1 × buffer ÷ (1.1 × 0.98 − collateral factor): under
    // $0.30 at 70% and a $0.10 buffer, so under the $1 smallest sale. The rule above stays for a larger buffer.
    const thin: SellPosition = {
      totalBackingUsd: 15.75,
      avgCf: 0.7,
      debtUsd: 10,
      debtRaw: usd(10),
      healthFactor: 1.1025,
    };
    const h: SellHolding = {
      priceUsd: price,
      freeRaw: 0n,
      backingRaw: shares(0.063),
      backingUsd: 15.75,
      paused: false,
    };
    const p = plan("repay", { ...quote, amountIn: shares(0.0048), amountOut: usd(1.194) }, thin, h);
    expect(p.repayRaw).toBe(minOut(usd(1.194)) - fee);
    expect(p.hfAfter!).toBeCloseTo((15.75 * 0.7 - 1.2 * 0.7) / (10 - Number(minOut(usd(1.194)) - fee) / 1e6), 6);
    expect(p.after).toBe("watch");
    expect(p.block).toBeUndefined();
  });

  it("repaying all of it ends with no credit", () => {
    const p = plan("repay", quote, owing(20));
    expect(p.repayRaw).toBe(usd(20) + usd(20) / 2000n + 1n);
    expect(p.hfAfter).toBeNull();
    expect(p.after).toBe("none");
  });

  it("blocks when nothing is owed, and a sale that repays nothing", () => {
    expect(plan("repay", quote, owing(0)).block).toBe("nothing-owed");
    expect(plan("repay", { ...quote, amountIn: shares(0.00002), amountOut: usd(0.005) }).block).toBe("too-small");
  });
});

describe("saleActivity", () => {
  it("lists each move the batch makes", () => {
    expect(saleActivity(nvda, plan("free", { ...quote, amountIn: shares(0.1), amountOut: usd(24.9) }))).toEqual([
      { kind: "sell", symbol: "NVDAc", amount: 0.1, receivedUsd: 24.9 },
    ]);
    expect(saleActivity(nvda, plan("repay", quote)).map((i) => i.kind)).toEqual(["withdraw", "sell", "repay"]);
    expect(saleActivity(nvda, plan("repay", quote)).at(-1)!.amount).toBeCloseTo(
      Number(minOut(usd(99.5)) - fee) / 1e6,
      6,
    );
  });
});

describe("floorPriceUsd (the review's lowest price)", () => {
  it("is what the sale pays at least, per share: the quote less 1% when that's over Aave's floor", () => {
    // 0.4 NVDA for $99.50: at least $98.505, so $246.26 a share (Aave's floor is $225).
    const p = plan("free", quote);
    expect(p.minOutRaw).toBe(minOut(usd(99.5)));
    expect(floorPriceUsd(p, nvda)).toBeCloseTo(98.505 / 0.4, 6);
  });

  it("is Aave's price less 10% when the pool pays less than that", () => {
    const thin: SellQuote = { ...quote, amountOut: usd(80) };
    expect(floorPriceUsd(plan("free", thin), nvda)).toBeCloseTo(price * 0.9, 6);
  });

  it("is 0 for no shares", () => {
    expect(floorPriceUsd({ minOutRaw: usd(1), sharesRaw: 0n }, nvda)).toBe(0);
  });
});

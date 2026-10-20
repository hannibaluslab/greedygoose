import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from "viem";

// The app's executor, before anything reads lib/agents/config.ts: the allowlist only lets it through once it's set.
const EXECUTOR = vi.hoisted(() => {
  const executor = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_EXECUTOR = executor;
  return executor;
});

import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import {
  inHomeOrder,
  isMix,
  mixWeights,
  nowPercents,
  previewTrades,
  rebalanceOptions,
  startingMix,
  unpackMix,
  wholePercents,
  type MixHolding,
} from "@/lib/agents/mix";
import { stockLimitsRaw } from "@/lib/agents/permissions";
import { buildSetKeepMixCalls, buildSetMixCalls } from "@/lib/agents/settings";
import { assertAllowed } from "@/lib/allowlist";
import { rebalanceTrades } from "@/lib/agents/rules/rebalance";
import { EQUITIES } from "@/lib/tokens/registry";

const user = "0x000000000000000000000000000000000000dEaD";
const price = (usd: number) => BigInt(Math.round(usd * 1e8));
/** `usd` dollars of free stock at `p`. */
const holding = (reserveId: number, usd: number, p: number): MixHolding => ({
  reserveId,
  priceRaw: price(p),
  freeRaw: BigInt(Math.round((usd / p) * 1e8)),
});
/** The Manage board's NVIDIA, Apple and Tesla at 43/26/30. */
const board = [holding(5, 4_300, 178.57), holding(0, 2_600, 222.22), holding(6, 3_000, 378.38)];
const boardMix = [
  { reserveId: 5, bps: 5_000 },
  { reserveId: 0, bps: 2_500 },
  { reserveId: 6, bps: 2_500 },
];
const options = rebalanceOptions();

describe("the mix GooseExecutor's setMix takes", () => {
  it("is seven whole BPS weights adding up to 100%, or all 0", () => {
    expect(isMix(mixWeights(boardMix))).toBe(true);
    expect(isMix([0, 0, 0, 0, 0, 0, 0])).toBe(true);
    expect(isMix(mixWeights([{ reserveId: 5, bps: 9_900 }]))).toBe(false);
    expect(isMix([10_000.5, 0, 0, 0, 0, 0, -0.5])).toBe(false);
    expect(isMix([10_000])).toBe(false);
  });

  it("unpacks the registry's 16 bits a stock", () => {
    const packed = (5_000n << 80n) | 2_500n | (2_500n << 96n);
    expect(unpackMix(packed)).toEqual([2_500, 0, 0, 0, 0, 5_000, 2_500]);
  });
});

describe("startingMix (what Manage opens on)", () => {
  it("is the saved mix, in Home's order (Apple first, Tesla last), whatever each weighs", () => {
    expect(startingMix(board, [2_500, 0, 0, 0, 0, 5_000, 2_500])).toEqual([
      { reserveId: 0, bps: 2_500 },
      { reserveId: 5, bps: 5_000 },
      { reserveId: 6, bps: 2_500 },
    ]);
  });

  it("before a mix is saved, is the free stock at its share now, adding up to 100%: nothing trades yet", () => {
    const rows = startingMix(board, [0, 0, 0, 0, 0, 0, 0]);
    expect(rows).toEqual([
      { reserveId: 0, bps: 2_600 },
      { reserveId: 5, bps: 4_400 },
      { reserveId: 6, bps: 3_000 },
    ]);
    expect(rows.reduce((a, r) => a + r.bps, 0)).toBe(10_000);
    expect(previewTrades({ holdings: board, rows, capRaw: 500_000_000n, capMaxRaw: null, options })).toEqual([]);
  });

  it("keeps Home's order when a stock is added to it", () => {
    const rows = startingMix(board, [2_500, 0, 0, 0, 0, 5_000, 2_500]);
    expect(inHomeOrder([...rows, { reserveId: 3, bps: 0 }]).map((r) => r.reserveId)).toEqual([0, 3, 5, 6]);
  });

  it("leaves out dust, and is empty with no free stock", () => {
    expect(startingMix([holding(1, 163, 258), holding(6, 140, 373), holding(4, 0.05, 545)], null)).toEqual([
      { reserveId: 1, bps: 5_400 },
      { reserveId: 6, bps: 4_600 },
    ]);
    expect(startingMix([holding(5, 0, 200)], null)).toEqual([]);
  });
});

describe("wholePercents and nowPercents", () => {
  it("rounds to whole percents that add up to 100, by largest remainder", () => {
    expect(wholePercents([1.26, 0.09, 0.05, 0.03, 0.03])).toEqual([86, 6, 4, 2, 2]);
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
  });

  it("shows each row's share of the free stock now, as the board's 43 / 26 / 30", () => {
    expect(nowPercents(board, boardMix)).toEqual([43, 26, 30]);
    expect(nowPercents([], boardMix)).toEqual([null, null, null]);
  });
});

describe("previewTrades (the Rebalancer's rule on today's free stock)", () => {
  it("is the rule itself, with the stock limits a grant at that limit carries", () => {
    const trades = previewTrades({
      holdings: board,
      rows: boardMix,
      capRaw: 500_000_000n,
      capMaxRaw: 10n ** 12n,
      options,
    });
    const prices = EQUITIES.map((e) => board.find((h) => h.reserveId === e.reserveId)?.priceRaw ?? 0n);
    const limits = stockLimitsRaw(
      500_000_000n,
      10n ** 12n,
      prices,
      mixWeights(boardMix).map((w) => w > 0),
    );
    const book = {
      stocks: EQUITIES.map((e) => {
        const h = board.find((x) => x.reserveId === e.reserveId);
        return {
          sharesRaw: h?.freeRaw ?? 0n,
          price: prices[e.reserveId],
          weightBps: BigInt(mixWeights(boardMix)[e.reserveId]),
          sellLeftRaw: limits[e.reserveId],
        };
      }),
      usdcLeftRaw: 500_000_000n,
    };
    expect(trades).toEqual(rebalanceTrades(book, options));
    expect(trades.length).toBeGreaterThan(0);
  });

  it("stays within what the grant's USDC limit allows, and trades nothing for a mix that doesn't add up", () => {
    const small = previewTrades({ holdings: board, rows: boardMix, capRaw: 100_000_000n, capMaxRaw: null, options });
    expect(small.filter((t) => t.buy).reduce((a, t) => a + t.amountIn, 0n)).toBeLessThanOrEqual(100_000_000n);
    expect(
      previewTrades({ holdings: board, rows: boardMix.slice(1), capRaw: 500_000_000n, capMaxRaw: null, options }),
    ).toEqual([]);
  });
});

describe("rebalanceOptions", () => {
  it("mirrors config/risk.ts before the executor is read, and takes its live numbers after", () => {
    expect(rebalanceOptions()).toEqual({
      bandBps: 2_000n,
      bandMaxBps: 500n,
      floorBps: 50n,
      minTradeRaw: 20_000_000n,
      maxSliceRaw: 25_000_000_000n,
    });
    expect(rebalanceOptions({ bandBps: 1_500, bandMaxBps: 400, floorBps: 40, minTrade: 1n, maxSlice: 2n })).toEqual({
      bandBps: 1_500n,
      bandMaxBps: 400n,
      floorBps: 40n,
      minTradeRaw: 1n,
      maxSliceRaw: 2n,
    });
  });
});

describe("the settings writes (one Face ID each, through useTx)", () => {
  it("setMix goes to the executor with the weights by reserve id", () => {
    const [call] = buildSetMixCalls(user, mixWeights(boardMix));
    expect(call.to).toBe(EXECUTOR);
    expect(call.value).toBe(0n);
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector("setMix(uint16[7])"));
    expect(decodeFunctionData({ abi: gooseExecutorAbi, data: call.data }).args).toEqual([
      [2_500, 0, 0, 0, 0, 5_000, 2_500],
    ]);
  });

  it("refuses a mix that doesn't add up to 100%", () => {
    expect(() => buildSetMixCalls(user, [5_000, 0, 0, 0, 0, 0, 0])).toThrow(/100%/);
    expect(() => buildSetMixCalls(user, [0, 0, 0, 0, 0, 0, 0])).toThrow(/100%/);
  });

  it("setKeepMix goes to the executor with the switch", () => {
    const [call] = buildSetKeepMixCalls(user, true);
    expect(call.to).toBe(EXECUTOR);
    expect(decodeFunctionData({ abi: gooseExecutorAbi, data: call.data })).toMatchObject({
      functionName: "setKeepMix",
      args: [true],
    });
  });

  it("the allowlist lets through only the executor's settings, with a mix that adds up", () => {
    const send = (data: `0x${string}`) => assertAllowed(user, [{ to: EXECUTOR, data, value: 0n }]);
    const bad = encodeFunctionData({
      abi: gooseExecutorAbi,
      functionName: "setMix",
      args: [[5_000, 0, 0, 0, 0, 0, 0]],
    });
    expect(() => send(bad)).toThrow(/Blocked: unexpected arguments to setMix/);
    const prune = encodeFunctionData({ abi: gooseExecutorAbi, functionName: "prune", args: [user, 0] });
    expect(() => send(prune)).toThrow(/Blocked: unexpected call/);
  });
});

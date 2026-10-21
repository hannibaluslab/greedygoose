import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { aprToApy } from "@/lib/aave/math";
import type { Call } from "@/lib/aave/tx";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, type Cash } from "@/lib/cash";
import {
  CREDIT_BLOCKED,
  CREDIT_FLOOR,
  backingForBuy,
  planCredit,
  type BackingOption,
  type BackingPick,
  type CreditPosition,
} from "@/lib/creditBuy";
import {
  RATE_UNREAD,
  cashRowLine,
  costCellText,
  gapLine,
  toCashLine,
  toCashQuote,
  toCashStop,
} from "@/lib/creditBuy/toCash";
import { explainRevert } from "@/lib/aave/errors";
import { assertEarn } from "@/lib/earnWithStocks";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { TxStop, type TxPlan } from "@/lib/tx/prepared";
import { toCashPlan } from "@/lib/tx/plans";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const other: Address = "0x00000000000000000000000000000000000000ee";
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const tsla = EQUITIES.find((e) => e.symbol === "TSLAc")!;
/** Thursday 2026-10-15, 11:00 New York: markets open. */
const NOW = new Date(Date.UTC(2026, 9, 15, 15, 0));

/** $900 of NVIDIA backs credit at 70%, $300 owed: health 2.1, Safe. */
const position = (over: Partial<CreditPosition> = {}): CreditPosition => ({
  totalBackingUsd: 900,
  avgCf: 0.7,
  debtUsd: 300,
  healthFactor: 2.1,
  usdcLiquidity: 2_770_000,
  creditPaused: false,
  ...over,
});
const cash: Cash = { walletRaw: usdc(1), savingsRaw: usdc(2_399), saveOn: true };
/** Under the fuel tank in the wallet: the network fee comes out of savings first. */
const lowWallet: Cash = { walletRaw: feeBufferRaw / 2n, savingsRaw: usdc(2_399), saveOn: true };
const teslaOption: BackingOption = {
  stock: tsla,
  freeRaw: BigInt(Math.round((1_400 / 378.38) * 1e8)),
  freeUsd: 1_400,
  cf: 0.7,
};

/** Base on 2026-10-20 (block 52,861,460): savings 3.817% APR, credit 3.885% APR, no risk premium. */
const LIVE = { cashApy: aprToApy(0.038169), creditApy: aprToApy(0.038854) };

const plan = (amountUsd: number, pick: BackingPick = { option: null, raw: 0n }, over: Partial<CreditPosition> = {}) =>
  planCredit({ position: position(over), backing: pick, creditRaw: usdc(amountUsd), cash, now: NOW });
const quote = (amountUsd: number, apyAfter: number | null = LIVE.creditApy, pick?: BackingPick) =>
  toCashQuote({
    plan: plan(amountUsd, pick),
    debtUsd: 300,
    cashApy: LIVE.cashApy,
    creditApyNow: LIVE.creditApy,
    creditApyAfter: apyAfter,
  });

const decodeSpoke = (c: Call) => decodeFunctionData({ abi: spokeAbi, data: c.data });
const decodePool = (c: Call) => decodeFunctionData({ abi: aaveV3PoolAbi, data: c.data });
const callsOf = async (p: TxPlan): Promise<Call[]> => (typeof p.calls === "function" ? p.calls() : p.calls);
const signed = (amountUsd: number, c: Cash = cash, pick?: BackingPick) =>
  callsOf(toCashPlan({ user, quote: quote(amountUsd, LIVE.creditApy, pick), confirmedRisk: false }, async () => c));

describe("Credit Buy's Cash row: the rates and the gap", () => {
  it("today's live rates: the cash earns 3.8%, the credit costs 4.0%, a gap of 0.2% against it", () => {
    const q = quote(100);
    expect(q.amountUsd).toBe(100);
    expect(q).toMatchObject({ earn: 38, cost: 40, gap: -2 });
  });

  it("the cost waits for the rate after the batch, and what the cash earns doesn't", () => {
    expect(quote(100, null)).toMatchObject({ earn: 38, cost: null, gap: null });
  });

  it("the cost counts what this credit adds to the whole debt's rate (marginalApy), rounded up", () => {
    // The rate after it rises 0.2 points on $300 owed plus $100: the $100 carries the whole rise.
    const q = quote(100, LIVE.creditApy + 0.002);
    expect(q.cost).toBe(48);
    expect(q.gap).toBe(-10);
  });

  it("the gap line: a cost rounded up, a gain rounded down, under $1 below a dollar", () => {
    expect(gapLine(-2, 100)).toBe("Costs 0.2% a year more than it earns, under $1 a year. Both rates are variable.");
    expect(gapLine(-2, 1_250)).toBe("Costs 0.2% a year more than it earns, about $3 a year. Both rates are variable.");
    expect(gapLine(3, 1_250)).toBe("Earns 0.3% a year more than it costs, about $3 a year. Both rates are variable.");
    expect(gapLine(-2, 0)).toBe("Costs 0.2% a year more than it earns. Both rates are variable.");
    expect(gapLine(0, 500)).toBe("Costs about what it earns. Both rates are variable.");
  });

  it("the gap line's dollars are exact on whole amounts (review 2026-10-21: 1.7% of $3,000 read $52)", () => {
    expect(gapLine(-17, 3_000)).toBe(
      "Costs 1.7% a year more than it earns, about $51 a year. Both rates are variable.",
    );
    expect(gapLine(9, 3_000)).toBe("Earns 0.9% a year more than it costs, about $27 a year. Both rates are variable.");
    expect(gapLine(18, 1_500)).toBe("Earns 1.8% a year more than it costs, about $27 a year. Both rates are variable.");
    expect(gapLine(-18, 3_500)).toBe(
      "Costs 1.8% a year more than it earns, about $63 a year. Both rates are variable.",
    );
    // Over the sweep the review ran, a cost is always rounded up and a gain down from the exact figure.
    for (let gap = 1; gap <= 60; gap++)
      for (let usd = 100; usd <= 20_000; usd += 100) {
        const exact = (gap * usd) / 1000;
        expect(gapLine(-gap, usd)).toContain(
          exact < 1 ? "under $1" : `about $${Math.ceil(exact - 1e-6).toLocaleString("en-US")} a year`,
        );
        expect(gapLine(gap, usd)).toContain(
          exact < 1 ? "under $1" : `about $${Math.floor(exact + 1e-6).toLocaleString("en-US")} a year`,
        );
      }
  });

  it("the Cost cell: the cost once read, today's rate while blocked, a dash when the read failed, … while it's read", () => {
    const read = quote(100, LIVE.creditApy + 0.002);
    const reading = quote(100, null);
    expect(costCellText(read, { failed: false, blocked: false, apyNow: LIVE.creditApy })).toBe("4.8%");
    expect(costCellText(reading, { failed: false, blocked: false, apyNow: LIVE.creditApy })).toBe("…");
    expect(costCellText(reading, { failed: false, blocked: true, apyNow: 0.0396 })).toBe("4.0%");
    expect(costCellText(reading, { failed: true, blocked: true, apyNow: 0.0396 })).toBe("—");
    expect(RATE_UNREAD).not.toMatch(/borrow|loan|lock|collateral|room|—/i);
  });

  it("a failed rate read is no cost: the Cash row can't be signed on today's rate (review 2026-10-21)", () => {
    const q = quote(100, null);
    expect(q.cost).toBeNull();
    expect(toCashStop(q, false)).toBe("One moment…");
  });

  it("Aave V3 savings' full supply cap says so, not the caller's fallback (0xf58f733a, measured on Base)", () => {
    expect(explainRevert("0xf58f733a", "fallback")).toBe(
      "Aave can’t take more cash into savings right now. Try again later.",
    );
  });

  it("the words: the row's line, where it goes, no banned words, no em dash", () => {
    expect(cashRowLine(38)).toBe("Earns 3.8% in savings");
    expect(toCashLine(38)).toBe("Goes to your cash, earning 3.8%");
    const all = [cashRowLine(38), toCashLine(38), gapLine(-2, 100), gapLine(3, 1_250), gapLine(0, 1)].join(" ");
    expect(all).not.toMatch(/borrow|loan|lock|collateral|room|aave|—/i);
  });
});

describe("Credit Buy's Cash row: when it can be signed", () => {
  it("costing more than the cash earns is no stop: the gap is shown first instead", () => {
    const q = quote(100);
    expect(q.gap).toBeLessThan(0);
    expect(toCashStop(q, false)).toBeNull();
  });

  it("stops: no amount, the plan's blocks, the rate still read, and the Watch tick", () => {
    expect(toCashStop(quote(0), false)).toBe("Enter an amount");
    const paused = toCashQuote({
      plan: plan(100, undefined, { creditPaused: true }),
      debtUsd: 300,
      cashApy: LIVE.cashApy,
      creditApyNow: LIVE.creditApy,
      creditApyAfter: LIVE.creditApy,
    });
    expect(toCashStop(paused, false)).toBe(CREDIT_BLOCKED.paused);
    // $1,000 more on $300 owed would end under 1.1: Act is the line, never a tick.
    expect(toCashStop(quote(1_000), false)).toBe(CREDIT_BLOCKED.act);
    expect(toCashStop(quote(100, null), false)).toBe("One moment…");
    // $900 × 70% ÷ (300 + 150) = 1.4: Watch, so the tick first.
    const watch = quote(150);
    expect(watch.plan.after).toBe("watch");
    expect(toCashStop(watch, false)).toMatch(/^Confirm you understand this puts your credit in Watch/);
    expect(toCashStop(watch, true)).toBeNull();
  });
});

describe("Credit Buy's Cash row: the batch (Earn with stocks', backed the Credit Buy way)", () => {
  it("Credit ready: the credit, then exactly that credit into savings for the account, and nothing else", async () => {
    const calls = await signed(100);
    expect(calls.map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, PROTOCOLS.AAVE_V3_POOL]);
    expect(decodeSpoke(calls[0])).toMatchObject({ functionName: "borrow", args: [7n, usdc(100), user] });
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1].data }).args).toEqual([
      PROTOCOLS.AAVE_V3_POOL,
      usdc(100),
    ]);
    // All of the credit earns: the wallet keeps nothing of it, so only the fuel tank stays there.
    expect(decodePool(calls[2])).toMatchObject({ functionName: "supply", args: [USDC.address, usdc(100), user, 0] });
    expect(calls.every((c) => c.value === 0n)).toBe(true);
  });

  it("a stock picked on step 1: just enough of it goes in use first, then the credit into savings", async () => {
    const pick: BackingPick = { option: teslaOption, raw: backingForBuy(teslaOption, 200) };
    expect(pick.raw).toBeGreaterThan(0n);
    expect(pick.raw).toBeLessThan(teslaOption.freeRaw);
    const calls = await signed(200, cash, pick);
    expect(calls.map((c) => c.to)).toEqual([
      tsla.address,
      AAVE.SPOKE,
      AAVE.SPOKE,
      AAVE.SPOKE,
      USDC.address,
      PROTOCOLS.AAVE_V3_POOL,
    ]);
    expect(decodeSpoke(calls[1])).toMatchObject({
      functionName: "supply",
      args: [BigInt(tsla.reserveId), pick.raw, user],
    });
    expect(decodeSpoke(calls[2]).functionName).toBe("setUsingAsCollateral");
    expect(decodeSpoke(calls[3])).toMatchObject({ functionName: "borrow", args: [7n, usdc(200), user] });
    expect(decodePool(calls[5]).args[1]).toBe(usdc(200));
  });

  it("with the wallet under the fuel tank, savings pay the network fee first", async () => {
    const calls = await signed(100, lowWallet);
    // Only what the wallet lacks of the fuel tank comes out.
    expect(decodePool(calls[0])).toMatchObject({
      functionName: "withdraw",
      args: [USDC.address, feeBufferRaw - lowWallet.walletRaw, user],
    });
    expect(calls.slice(1).map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, PROTOCOLS.AAVE_V3_POOL]);
  });

  it("the plan: stopped again at signing, the health floor on, keyed by what shapes it, Activity's earn", async () => {
    const cashToSign = vi.fn(async () => cash);
    const none = toCashPlan({ user, quote: quote(0), confirmedRisk: false }, cashToSign);
    await expect(callsOf(none)).rejects.toBeInstanceOf(TxStop);
    expect(cashToSign).not.toHaveBeenCalled();
    const p = toCashPlan({ user, quote: quote(100), confirmedRisk: false }, cashToSign);
    expect(p.healthFloor).toEqual(CREDIT_FLOOR);
    expect(p.activity).toEqual([{ kind: "earn", symbol: "USDC", amount: 100 }]);
    const key = (amount: number, ack = false) =>
      toCashPlan({ user, quote: quote(amount), confirmedRisk: ack }, cashToSign).key;
    expect(key(100)).not.toBe(key(101));
    expect(key(150)).not.toBe(key(150, true));
    expect(key(100)).toBe(key(100));
  });
});

describe("Credit Buy's Cash row: the allowlist holds it narrowly", () => {
  const swapArg = (c: Call, args: readonly unknown[]): Call => ({
    ...c,
    data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "supply", args: args as never }),
  });

  it("the savings supply passes only in a batch that declares it saves for the account", async () => {
    const calls = await signed(100);
    expect(assertAllowed(user, calls, { saveTo: user })).toBe(calls);
    expect(() => assertAllowed(user, calls)).toThrow();
    expect(() => assertAllowed(user, calls, { saveTo: other })).toThrow();
  });

  it("savings for someone else, or less than the credit (cash left in the wallet), are blocked", async () => {
    const calls = await signed(100);
    const forOther = [...calls.slice(0, 2), swapArg(calls[2], [USDC.address, usdc(100), other, 0])];
    expect(() => assertAllowed(user, forOther, { saveTo: user })).toThrow();
    const review = { creditRaw: usdc(100), backing: [], limit: plan(100).limit };
    const short = [
      calls[0],
      {
        ...calls[1],
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PROTOCOLS.AAVE_V3_POOL, usdc(99)] }),
      },
      swapArg(calls[2], [USDC.address, usdc(99), user, 0]),
    ];
    expect(() => assertEarn(user, short, review)).toThrow(/differs from the credit/);
    expect(() => assertEarn(user, calls, { ...review, limit: { ...review.limit, maxCreditRaw: usdc(99) } })).toThrow(
      /more credit than the backing allows/,
    );
  });
});

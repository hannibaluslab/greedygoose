import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256, parseUnits } from "viem";
import { CASH, CREDIT_CAP, RISK } from "@/config/risk";
import { assertAllowed, swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { FILL_MARGIN, fillRaw } from "@/lib/aave/credit";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { buildCreditCalls } from "@/lib/aave/tx";
import { payFromCash } from "@/lib/cash";
import {
  CREDIT_BLOCKED,
  CREDIT_FROM,
  FEE_FIRST,
  NO_CREDIT,
  assertCreditBuy,
  backers,
  backingOptions,
  backingRawFor,
  bestBacking,
  buildCreditBuyCalls,
  creditAvailable,
  creditBuyActivity,
  creditBuyStop,
  creditCap,
  creditWith,
  freeShownUsd,
  isAllFree,
  noCreditLine,
  planCredit,
  shortNames,
  splitCash,
  type BackingOption,
  type CreditLimit,
  type CreditPosition,
} from "@/lib/creditBuy";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { statusFor } from "@/lib/risk/status";
import { BUY_LIMITS, buildBuyCalls, minOut, type BuyQuote } from "@/lib/swap/buy";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { formatUsd } from "@/lib/formatting";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const attacker: `0x${string}` = "0x00000000000000000000000000000000000000ee";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const toUsdc = (raw: bigint) => Number(raw) / 1e6;
const fee = usd(CASH.feeBufferUsd);
const B = CASH.feeBufferUsd;
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const msft = EQUITIES.find((e) => e.symbol === "MSFTc")!;
const meta = EQUITIES.find((e) => e.symbol === "METAc")!;
const quote: BuyQuote = { venue: "aerodrome", pool: 10, amountIn: usd(300), amountOut: 135_000_000n }; // $300 → 1.35 AAPLc
const walletCash = { walletRaw: usd(40), savingsRaw: 0n, saveOn: true };
/** A limit that doesn't bite: for the tests about the batch's shape. */
const roomy: CreditLimit = { maxCreditRaw: usd(1_000_000), freeRaw: { NVDAc: 10n ** 12n } };
const fn = (data: `0x${string}`) =>
  decodeFunctionData({ abi: [...erc20Abi, ...spokeAbi, ...aaveV3PoolAbi], data }).functionName;
const steps = (calls: { data: `0x${string}`; to: `0x${string}` }[]) =>
  calls.map((c) => (swapOf(c) ? "swap" : fn(c.data)));

describe("buildCreditBuyCalls (plan item 3)", () => {
  it("first-time backing: put the stock in use → take credit → approve → swap, in that order", () => {
    const calls = buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote,
      creditRaw: quote.amountIn,
      backing: [{ stock: nvda, raw: 336_000_000n }],
      cash: walletCash,
      nowSec: 1_000,
    });
    expect(steps(calls)).toEqual(["approve", "supply", "setUsingAsCollateral", "borrow", "approve", "swap"]);
    expect(calls.map((c) => c.to)).toEqual([
      nvda.address,
      AAVE.SPOKE,
      AAVE.SPOKE,
      AAVE.SPOKE,
      USDC.address,
      AERODROME.ROUTER,
    ]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[1].data }).args).toEqual([5n, 336_000_000n, user]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[3].data }).args).toEqual([7n, usd(300), user]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[4].data }).args).toEqual([AERODROME.ROUTER, usd(300)]);
    const { params } = swapOf(calls[5])!;
    expect(params).toMatchObject({
      tokenIn: USDC.address,
      tokenOut: aapl.address,
      recipient: user,
      amountIn: usd(300),
    });
    expect((params as unknown as { amountOutMinimum: bigint }).amountOutMinimum).toBe(minOut(quote.amountOut));
  });

  it("already backing: take credit → approve → swap, nothing else", () => {
    const calls = buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote,
      creditRaw: quote.amountIn,
      backing: [],
      cash: walletCash,
    });
    expect(steps(calls)).toEqual(["borrow", "approve", "swap"]);
  });

  it("the network fee comes from cash: a $0 wallet takes just the fee buffer out of savings first", () => {
    const calls = buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote,
      creditRaw: quote.amountIn,
      backing: [],
      cash: { walletRaw: 0n, savingsRaw: usd(100), saveOn: true },
    });
    expect(steps(calls)).toEqual(["withdraw", "borrow", "approve", "swap"]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, fee, user]);
  });

  it("Uniswap route: the swap sits in multicall with its deadline, and is still checked", () => {
    const uni = { ...quote, venue: "uniswap" as const, pool: 3000 };
    const calls = buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote: uni,
      creditRaw: uni.amountIn,
      backing: [],
      cash: walletCash,
    });
    expect(calls.map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, UNISWAP.SWAP_ROUTER_02]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1].data }).args).toEqual([UNISWAP.SWAP_ROUTER_02, usd(300)]);
  });

  it("refuses a buy that doesn't spend the credit, no credit, a stock that isn't one of the 7, and cash short of the fee", () => {
    const base = { user, stock: aapl, quote, backing: [], limit: roomy, cash: walletCash };
    expect(() => buildCreditBuyCalls({ ...base, creditRaw: quote.amountIn + 1n })).toThrow(
      /Credit must be part of the buy/,
    );
    expect(() => buildCreditBuyCalls({ ...base, creditRaw: 0n })).toThrow(/Credit must be part of the buy/);
    expect(() => buildCreditBuyCalls({ ...base, stock: USDC, creditRaw: quote.amountIn })).toThrow(
      /Not a supported stock/,
    );
    expect(() =>
      buildCreditBuyCalls({
        ...base,
        creditRaw: quote.amountIn,
        cash: { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true },
      }),
    ).toThrow(/More than your cash/);
  });
});

describe("decision 1: more than your cash", () => {
  it("splitCash: cash pays all it can (less the fee buffer), credit the other part", () => {
    const cash = { walletRaw: usd(40), savingsRaw: usd(60), saveOn: true };
    expect(splitCash(usd(80), cash)).toEqual({ cashRaw: usd(80), creditRaw: 0n });
    expect(splitCash(usd(300), cash)).toEqual({ cashRaw: usd(100) - fee, creditRaw: usd(200) + fee });
    expect(splitCash(usd(5), { walletRaw: fee / 2n, savingsRaw: 0n, saveOn: true })).toEqual({
      cashRaw: 0n,
      creditRaw: usd(5),
    });
  });

  it("one batch: withdraw savings → put backing in use → take credit for the rest → approve → swap", () => {
    const cash = { walletRaw: 0n, savingsRaw: usd(100), saveOn: true };
    const { cashRaw, creditRaw } = splitCash(quote.amountIn, cash);
    const calls = buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote,
      creditRaw,
      backing: [{ stock: nvda, raw: 1n }],
      cash,
    });
    expect(steps(calls)).toEqual([
      "withdraw",
      "approve",
      "supply",
      "setUsingAsCollateral",
      "borrow",
      "approve",
      "swap",
    ]);
    // All of savings comes out (max uint): they are the last of the cash.
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([
      USDC.address,
      maxUint256,
      user,
    ]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[4].data }).args[1]).toBe(creditRaw);
    expect(swapOf(calls[6])!.params.amountIn).toBe(cashRaw + creditRaw);
    expect(cashRaw + creditRaw).toBe(quote.amountIn);
  });
});

describe("assertCreditBuy (the batch against the review)", () => {
  const review = { stock: aapl, creditRaw: quote.amountIn, cashRaw: 0n, backing: [], limit: roomy };
  const good = () =>
    buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote,
      creditRaw: quote.amountIn,
      backing: [],
      cash: walletCash,
    });

  it("passes the builder's batch", () => {
    const calls = good();
    expect(assertCreditBuy(user, calls, review)).toBe(calls);
  });
  it("blocks credit or a swap that differs from the review", () => {
    expect(() => assertCreditBuy(user, good(), { ...review, creditRaw: quote.amountIn - 1n })).toThrow(
      /credit differs/,
    );
    expect(() => assertCreditBuy(user, good(), { ...review, cashRaw: 1n })).toThrow(/credit differs|swap differs/);
    expect(() => assertCreditBuy(user, good(), { ...review, stock: msft })).toThrow(/swap differs/);
  });
  it("blocks another account's batch", () => {
    const theirs = buildCreditBuyCalls({
      limit: roomy,
      user: attacker,
      stock: aapl,
      quote,
      creditRaw: quote.amountIn,
      backing: [],
      cash: walletCash,
    });
    expect(() => assertCreditBuy(user, theirs, review)).toThrow(/credit differs/);
  });
  it("blocks a batch out of order, with a second credit or swap, or without its approve", () => {
    const [creditCall, approve, swap] = good();
    expect(() => assertCreditBuy(user, [approve, swap, creditCall], review)).toThrow(/swap must come last/);
    expect(() =>
      assertCreditBuy(user, [creditCall, ...buildCreditCalls({ user, amountRaw: 1n }), approve, swap], review),
    ).toThrow(/once/);
    expect(() => assertCreditBuy(user, [creditCall, approve, swap, swap], review)).toThrow(/once/);
    expect(() => assertCreditBuy(user, [creditCall], review)).toThrow(/once/);
    expect(() => assertCreditBuy(user, [approve, creditCall, swap], review)).toThrow(/approval differs/);
    const [uniApprove] = buildBuyCalls({ user, stock: aapl, quote: { ...quote, venue: "uniswap", pool: 3000 } });
    expect(() => assertCreditBuy(user, [creditCall, uniApprove, swap], review)).toThrow(/approval differs/);
  });
});

describe("payFromCash with nothing to pay but the fee", () => {
  const spend = buildCreditCalls({ user, amountRaw: 1n });
  it("takes the fee buffer out of savings when the wallet can't cover it", () => {
    const calls = payFromCash(user, 0n, { walletRaw: 0n, savingsRaw: usd(10), saveOn: true }, spend);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, fee, user]);
    expect(payFromCash(user, 0n, { walletRaw: fee, savingsRaw: usd(10), saveOn: true }, spend)).toEqual(spend);
  });
  it("refuses when cash can't pay the fee", () => {
    expect(() => payFromCash(user, 0n, { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true }, spend)).toThrow(
      /More than your cash/,
    );
  });
});

describe("planCredit (Leo's credit maths: autoFill, combinedCredit, status)", () => {
  // Sam: no credit yet, $2,000 of free NVIDIA (70% counts), $40 of cash.
  const fresh: CreditPosition = {
    totalBackingUsd: 0,
    avgCf: 0,
    debtUsd: 0,
    healthFactor: null,
    usdcLiquidity: 1_000_000,
    creditPaused: false,
  };
  const nvdaFree: BackingOption = { stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 };
  const msftFree: BackingOption = { stock: msft, freeRaw: 100_000_000n, freeUsd: 500, cf: 0.78 };
  const weekday = new Date("2026-10-14T15:00:00Z");
  const saturday = new Date("2026-10-17T15:00:00Z");
  const plan = (creditUsd: number, position = fresh, options = [nvdaFree], now = weekday) =>
    planCredit({ position, options, creditRaw: usd(creditUsd), cash: walletCash, now });

  it("first-time backing: puts in just enough NVIDIA to start Safe, plus the fill margin", () => {
    const p = plan(300);
    expect(p.backing).toHaveLength(1);
    expect(p.backing[0].stock).toBe(nvda);
    // Safe at 1.5: 300 × 1.5 / 0.7 = $642.86 of NVIDIA, plus FILL_MARGIN.
    expect(p.backing[0].usd).toBeCloseTo((300 * 1.5 * FILL_MARGIN) / 0.7, 0);
    expect(p.before).toBe("none");
    expect(p.after).toBe("safe");
    expect(p.hfAfter).toBeGreaterThanOrEqual(1.5);
    expect(p.extraConfirm).toBe(false);
    expect(p.block).toBeUndefined();
    expect(p.maxSafeUsd).toBe(933.33);
    expect(p.maxUsd).toBe(1250); // $2,000 × 70% ÷ 1.12: the most that stays out of Act with the margin
  });

  it("already backing: what backs credit covers it, so nothing new goes in", () => {
    const backed: CreditPosition = { ...fresh, totalBackingUsd: 9_000, avgCf: 0.73, debtUsd: 1_200, healthFactor: 5.4 };
    const p = plan(300, backed);
    expect(p.backing).toEqual([]);
    expect(p.before).toBe("safe");
    expect(p.after).toBe("safe");
    expect(p.hfAfter).toBeCloseTo((9_000 * 0.73) / 1_500, 6);
  });

  it("tops up from the highest collateral factor first", () => {
    const p = plan(300, fresh, [nvdaFree, msftFree]);
    expect(p.backing.map((b) => b.stock.symbol)).toEqual(["NVDAc", "MSFTc"]);
    expect(p.backing[1].raw).toBe(msftFree.freeRaw); // all of the MSFT ($500 × 0.78) goes in, NVIDIA covers the rest
  });

  it("past Safe it puts everything in and asks for the extra confirmation in Watch; ending in Act is blocked, not ticked", () => {
    const watch = plan(1_100);
    expect(watch.backing[0].raw).toBe(nvdaFree.freeRaw);
    expect(watch.after).toBe("watch");
    expect(watch.extraConfirm).toBe(true);
    expect(watch.block).toBeUndefined();
    const act = plan(1_350);
    expect(act.after).toBe("act");
    expect(act.block).toBe("act");
    expect(act.extraConfirm).toBe(false);
  });

  it("blocks past the MAX, with no USDC to lend, when Aave pauses credit, or when cash can't pay the fee", () => {
    expect(plan(1_251).block).toBe("too-much"); // still Watch (1.119), but past the margin
    expect(plan(1_394).block).toBe("act"); // what 99.5% of Aave's limit used to allow
    expect(plan(300, { ...fresh, usdcLiquidity: 299 }).block).toBe("no-liquidity");
    expect(plan(300, { ...fresh, creditPaused: true }).block).toBe("paused");
    const broke = planCredit({
      position: fresh,
      options: [nvdaFree],
      creditRaw: usd(300),
      cash: { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true },
      now: weekday,
    });
    expect(broke.block).toBe("fee");
  });

  it("weekends: allowed, and the review says the price may move (CLAUDE.md › Market hours)", () => {
    const p = plan(300, fresh, [nvdaFree], saturday);
    expect(p.block).toBeUndefined();
    expect(p.priceMayMove).toBe(true);
    expect(plan(300).priceMayMove).toBe(false);
  });
});

describe('creditAvailable (F2-3\'s "You can use up to")', () => {
  const fresh: CreditPosition = {
    totalBackingUsd: 0,
    avgCf: 0,
    debtUsd: 0,
    healthFactor: null,
    usdcLiquidity: 1_000_000,
    creditPaused: false,
  };
  const nvdaFree: BackingOption = { stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 };
  const msftFree: BackingOption = { stock: msft, freeRaw: 100_000_000n, freeUsd: 500, cf: 0.78 };
  const noCash = { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true };
  const avail = (position: CreditPosition, options: BackingOption[], holdsStock = true, cash = walletCash) =>
    creditAvailable({ position, options, cash, holdsStock });
  const perStock = (position: CreditPosition, o: BackingOption) =>
    planCredit({ position, options: [o], creditRaw: 0n, cash: walletCash }).maxUsd;

  it("is the largest of F2-4's per-stock figures, not their sum: one buy is backed by one free holding", () => {
    expect(avail(fresh, [nvdaFree])).toEqual({ usd: 1_250, line: CREDIT_FROM }); // $2,000 × 70% ÷ 1.12, the cap
    const both = avail(fresh, [msftFree, nvdaFree]);
    expect(both.usd).toBe(Math.max(perStock(fresh, nvdaFree), perStock(fresh, msftFree)));
    expect(both.usd).toBe(1_250);
  });

  it("creditWith is F2-4's per-stock figure: planCredit's MAX with that one option, or with none", () => {
    expect(creditWith(fresh, nvdaFree)).toBe(perStock(fresh, nvdaFree));
    expect(creditWith(fresh, msftFree)).toBe(perStock(fresh, msftFree));
    const backed: CreditPosition = { ...fresh, totalBackingUsd: 1_000, avgCf: 0.7, debtUsd: 300, healthFactor: 2.33 };
    expect(creditWith(backed)).toBe(
      planCredit({ position: backed, options: [], creditRaw: 0n, cash: walletCash }).maxUsd,
    );
  });

  it("is what F2-4 picks first and F2-5 offers: the holding with the most free stock isn't always the one that backs the most", () => {
    // Live collateral factors differ by stock: $1,000 of Meta at 65% backs less than $900 of Microsoft at 79%.
    const metaFree: BackingOption = { stock: meta, freeRaw: 140_000_000n, freeUsd: 1_000, cf: 0.65 };
    const msft900: BackingOption = { stock: msft, freeRaw: 180_000_000n, freeUsd: 900, cf: 0.79 };
    const options = [metaFree, msft900]; // as the sheet sorts them: most free stock first
    const best = bestBacking(fresh, options)!;
    expect(best.option).toBe(msft900);
    const headline = avail(fresh, options).usd;
    expect(headline).toBe(634.82); // 900 × 79% ÷ 1.12, not Meta's $580.35
    // F2-5's "Up to" for the default pick is the plan with that one option.
    expect(planCredit({ position: fresh, options: [best.option], creditRaw: 0n, cash: walletCash }).maxUsd).toBe(
      headline,
    );
    expect(best.usd).toBe(headline);
  });

  it("ties go to the most free stock, whatever the order", () => {
    const capped: CreditPosition = { ...fresh, usdcLiquidity: 100 }; // both hit what can be lent
    expect(bestBacking(capped, [msftFree, nvdaFree])!.option).toBe(nvdaFree);
    expect(bestBacking(capped, [nvdaFree, msftFree])!.option).toBe(nvdaFree);
    expect(bestBacking(fresh, [])).toBeNull();
  });

  it("counts what already backs credit, net of what's owed", () => {
    const backed: CreditPosition = { ...fresh, totalBackingUsd: 1_000, avgCf: 0.7, debtUsd: 300, healthFactor: 2.33 };
    // (1,000 × 0.7 + 2,000 × 0.7) ÷ 1.12 − 300
    expect(avail(backed, [nvdaFree]).usd).toBe(1_575);
    // Everything in use: the room on it alone, 1,000 × 0.7 ÷ 1.12 − 300.
    expect(avail(backed, [])).toEqual({ usd: 325, line: CREDIT_FROM });
  });

  it("never more than there is to lend", () => {
    expect(avail({ ...fresh, usdcLiquidity: 500 }, [nvdaFree]).usd).toBe(500);
  });

  it("with credit but less cash than the network fee, keeps the number and asks for the fee first (F2-5 would block every amount)", () => {
    const a = avail(fresh, [nvdaFree], true, noCash);
    expect(a).toEqual({ usd: 1_250, line: FEE_FIRST });
    expect(FEE_FIRST).toBe(`Add ${formatUsd(B)} to your cash for the network fee first.`);
    expect(planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(10), cash: noCash }).block).toBe("fee");
    // Just enough for the fee: the usual line.
    expect(avail(fresh, [nvdaFree], true, { walletRaw: fee, savingsRaw: 0n, saveOn: true }).line).toBe(CREDIT_FROM);
  });

  it("$0 with the reason: no stock, nothing that can back credit, everything in use, in Act, paused, nothing to lend", () => {
    expect(avail(fresh, [], false)).toEqual({ usd: 0, why: "no-stocks", line: noCreditLine("no-stocks", true) });
    expect(avail(fresh, [])).toMatchObject({ usd: 0, why: "cant-back" });
    // At the cap (700 ÷ 625 = 1.12, Watch): everything that backs credit is in use.
    const full: CreditPosition = { ...fresh, totalBackingUsd: 1_000, avgCf: 0.7, debtUsd: 625, healthFactor: 1.12 };
    expect(avail(full, [])).toMatchObject({ usd: 0, why: "all-in-use" });
    // Past Aave's limit's Act line: in Act, whatever is free.
    const act: CreditPosition = { ...fresh, totalBackingUsd: 1_000, avgCf: 0.7, debtUsd: 700, healthFactor: 1 };
    expect(avail(act, [nvdaFree])).toMatchObject({ usd: 0, why: "in-act", line: noCreditLine("in-act", true) });
    expect(avail({ ...fresh, creditPaused: true }, [nvdaFree])).toMatchObject({ usd: 0, why: "paused" });
    // A cent of free NVIDIA counts for under the smallest buy (a cent), and nothing backs credit yet: too small, not "all in use".
    const tiny: BackingOption = { stock: nvda, freeRaw: 5_600n, freeUsd: 0.01, cf: 0.7 };
    expect(avail(fresh, [tiny])).toMatchObject({ usd: 0, why: "too-small", line: noCreditLine("too-small", true) });
    expect(avail(full, [tiny])).toMatchObject({ why: "all-in-use" });
    expect(avail({ ...fresh, usdcLiquidity: 0 }, [nvdaFree])).toMatchObject({ usd: 0, why: "no-liquidity" });
  });

  it("under the smallest buy (a cent) is $0: no Credit Buy fits in it", () => {
    const nearly: CreditPosition = {
      ...fresh,
      totalBackingUsd: 1_000,
      avgCf: 0.7,
      debtUsd: 624.995,
      healthFactor: 700 / 624.995,
    }; // half a cent left
    expect(avail(nearly, [])).toMatchObject({ usd: 0, why: "all-in-use" });
  });

  it("at $0, says cash still buys, or to top up when cash can't pay the smallest buy and its fee", () => {
    expect(avail(fresh, [], false).line).toBe("Credit comes from the stocks you own. Buy one with cash first.");
    expect(avail(fresh, [], false, { walletRaw: 0n, savingsRaw: 0n, saveOn: false }).line).toBe(
      "Credit comes from the stocks you own. Top up, then buy one with cash.",
    );
    // A cent short of the smallest buy (a cent) plus the fee buffer: it doesn't fit.
    expect(avail(fresh, [], true, { walletRaw: usd(B), savingsRaw: 0n, saveOn: false }).line).toBe(
      "Your stocks can’t back credit right now. Top up to buy with cash.",
    );
    expect(avail(fresh, [], true, { walletRaw: usd(0.01 + B), savingsRaw: 0n, saveOn: false }).line).toBe(
      "Your stocks can’t back credit right now. You can still buy with cash.",
    );
  });

  it("says why in plain words, without the words D17 keeps off screen or Aave's", () => {
    const lines = [
      CREDIT_FROM,
      FEE_FIRST,
      ...(Object.keys(NO_CREDIT) as (keyof typeof NO_CREDIT)[]).flatMap((why) => [
        noCreditLine(why, true),
        noCreditLine(why, false),
      ]),
    ];
    for (const line of lines) expect(line).not.toMatch(/creditCall|loan|lock|aave|collateral|health/i);
  });
});

describe("creditBuyStop and creditBuyActivity (what the hooks check and record)", () => {
  const position: CreditPosition = {
    totalBackingUsd: 0,
    avgCf: 0,
    debtUsd: 0,
    healthFactor: null,
    usdcLiquidity: 1_000_000,
    creditPaused: false,
  };
  const options: BackingOption[] = [{ stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 }];
  const plan = (creditUsd: number) =>
    planCredit({
      position,
      options,
      creditRaw: usd(creditUsd),
      cash: walletCash,
      now: new Date("2026-10-14T15:00:00Z"),
    });

  it("lets a Safe plan through, and holds Watch or Act until it's confirmed", () => {
    expect(creditBuyStop(plan(300), false)).toBeNull();
    expect(creditBuyStop(plan(1_100), false)).toMatch(/credit in Watch/);
    expect(creditBuyStop(plan(1_100), true)).toBeNull();
  });
  it("a block stops it even when confirmed: past the cap, and ending in Act, which no tick lets through", () => {
    expect(creditBuyStop(plan(1_260), true)).toBe(CREDIT_BLOCKED["too-much"]);
    expect(creditBuyStop(plan(5_000), true)).toBe(CREDIT_BLOCKED.act);
  });
  it("records the backing, the credit and the buy", () => {
    const p = plan(300);
    expect(creditBuyActivity({ stock: aapl, quote, plan: p })).toEqual([
      { kind: "supply", symbol: "NVDAc", amount: Number(p.backing[0].raw) / 1e8 },
      { kind: "borrow", symbol: "USDC", amount: 300 },
      { kind: "buy", symbol: "AAPLc", amount: 1.35, paidUsd: 300 },
    ]);
  });
});

describe("backingOptions", () => {
  const h = (
    symbol: string,
    over: Partial<{ freeRaw: bigint; freeUsd: number; paused: boolean; frozen: boolean }> = {},
  ) => ({
    symbol,
    freeRaw: 1n,
    freeUsd: 100,
    paused: false,
    frozen: false,
    ...over,
  });
  it("lists free stock with a collateral factor that isn't paused, frozen or dust", () => {
    const cfs = { AAPLc: 0.78, NVDAc: 0.7, MSFTc: 0.78, METAc: 0 };
    const opts = backingOptions(
      [
        h("AAPLc"),
        h("NVDAc", { paused: true }),
        h("MSFTc", { freeUsd: 0.001 }),
        h("METAc"),
        h("TSLAc"),
        h("AMZNc", { frozen: true }),
      ],
      cfs,
    );
    expect(opts.map((o) => [o.stock.symbol, o.cf])).toEqual([["AAPLc", 0.78]]);
  });
});

describe('what backs it, by name (the sheet\'s "Against" and "Backed by")', () => {
  const h = (symbol: string, name: string, backingRaw = 0n) => ({ symbol, name, backingRaw });
  const holdings = [h("AMZNc", "Amazon", 5n), h("METAc", "Meta"), h("NVDAc", "NVIDIA", 2n), h("TSLAc", "Tesla")];
  const names = (adding: string[], lead?: string, list = holdings) => backers(list, adding, lead).map((b) => b.name);
  it("lists what goes in use, then what's in use already, once each, with the picked holding first", () => {
    expect(names(["METAc"], "METAc")).toEqual(["Meta", "Amazon", "NVIDIA"]);
    expect(names(["NVDAc"], "NVDAc")).toEqual(["NVIDIA", "Amazon"]);
    expect(names([], "NVDAc")).toEqual(["NVIDIA", "Amazon"]);
    expect(names([], "METAc")).toEqual(["Amazon", "NVIDIA"]);
    expect(names(["TSLAc"], undefined, [h("TSLAc", "Tesla")])).toEqual(["Tesla"]);
  });
  it("shortNames keeps the line short", () => {
    expect(shortNames(["NVIDIA"])).toBe("NVIDIA");
    expect(shortNames(["NVIDIA", "Tesla"])).toBe("NVIDIA and Tesla");
    expect(shortNames(["Meta", "Amazon", "NVIDIA"])).toBe("Meta and 2 more");
  });
});

describe("fillRaw", () => {
  it("adds the margin, caps at the balance, and rounds 99.99% up to all of it", () => {
    expect(fillRaw(1_000_000n, 100, 50)).toBe(501_500n);
    expect(fillRaw(1_000_000n, 100, 99.8)).toBe(1_000_000n);
    expect(fillRaw(1_000_000n, 100, 0)).toBe(0n);
  });

  it("a small fill out of a large holding keeps its margin, so the plan starts Safe", () => {
    // $382,000 of free Apple (78% counts) and $5 of credit: Safe needs $9.62 of it in use.
    const freeRaw = 110_921_547_669n;
    const freeUsd = 382_000;
    const need = (RISK.safeMin * 5) / 0.78;
    const raw = fillRaw(freeRaw, freeUsd, need);
    expect((Number(raw) * freeUsd) / Number(freeRaw)).toBeGreaterThanOrEqual(
      need * FILL_MARGIN - freeUsd / Number(freeRaw),
    ); // within one raw unit
    const fresh: CreditPosition = {
      totalBackingUsd: 0,
      avgCf: 0,
      debtUsd: 0,
      healthFactor: null,
      usdcLiquidity: 1_000_000,
      creditPaused: false,
    };
    const plan = planCredit({
      position: fresh,
      options: [{ stock: aapl, freeRaw, freeUsd, cf: 0.78 }],
      creditRaw: usd(5),
      cash: walletCash,
    });
    expect(plan).toMatchObject({ after: "safe", extraConfirm: false, block: undefined });
    expect(plan.hfAfter).toBeGreaterThanOrEqual(RISK.safeMin);
  });
});

describe("planCredit with an explicit backing (Credit Buy goes backing first, Adrian 2026-10-15)", () => {
  // Sam: no credit yet, $2,000 of free NVIDIA (70% counts), $40 of cash.
  const fresh: CreditPosition = {
    totalBackingUsd: 0,
    avgCf: 0,
    debtUsd: 0,
    healthFactor: null,
    usdcLiquidity: 1_000_000,
    creditPaused: false,
  };
  const backed: CreditPosition = { ...fresh, totalBackingUsd: 1_000, avgCf: 0.7, debtUsd: 300, healthFactor: 2.33 };
  const nvdaFree: BackingOption = { stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 };
  const weekday = new Date("2026-10-14T15:00:00Z");
  const withBacking = (typedUsd: number, creditUsd = 0, position = fresh, option: BackingOption | null = nvdaFree) =>
    planCredit({
      position,
      backing: { option, raw: option ? backingRawFor(option, typedUsd) : 0n },
      creditRaw: usd(creditUsd),
      cash: walletCash,
      now: weekday,
    });

  it("the typed dollars become raw units in proportion to the free value, and exactly that goes in (no fill margin)", () => {
    expect(backingRawFor(nvdaFree, 500)).toBe(280_000_000n); // a quarter of the free shares
    const p = withBacking(500, 300);
    expect(p.backing).toEqual([{ stock: nvda, raw: 280_000_000n, usd: 500 }]);
    // autoFill would have put in $645 (300 × 1.5 / 0.7 plus the margin); the pick is what Sam typed.
    expect(
      planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(300), cash: walletCash, now: weekday })
        .backing[0].usd,
    ).toBeCloseTo((300 * 1.5 * FILL_MARGIN) / 0.7, 0);
  });

  it("the credit limit grows with the backing: what it counts for, over the cap's line (1.12)", () => {
    const limits = [0, 100, 500, 1_000, 2_000].map((u) => withBacking(u).maxUsd);
    expect(limits).toEqual([0, 62.5, 312.5, 625, 1_250]);
    expect(withBacking(500).maxSafeUsd).toBe(233.33); // 500 × 70% / 1.5
  });

  it("MAX is all the free shares exactly, and gives Invest's number (creditWith)", () => {
    expect(backingRawFor(nvdaFree, nvdaFree.freeUsd)).toBe(nvdaFree.freeRaw);
    // Within half a cent of all of it is all of it: no dust left behind.
    expect(backingRawFor(nvdaFree, 1_999.996)).toBe(nvdaFree.freeRaw);
    expect(backingRawFor(nvdaFree, 1_999.99)).toBeLessThan(nvdaFree.freeRaw);
    const all = planCredit({
      position: fresh,
      backing: { option: nvdaFree, raw: nvdaFree.freeRaw },
      creditRaw: 0n,
      cash: walletCash,
    });
    expect(all.backing[0].raw).toBe(nvdaFree.freeRaw);
    expect(all.maxUsd).toBe(creditWith(fresh, nvdaFree));
  });

  it("typing the whole free value is all of it, from the cent MAX shows to half a cent over; clearly more stays more", () => {
    // Free $96.5612: MAX fills in $96.56, and typing that is all of it, as is the rounded $96.57 shown elsewhere.
    const amzn: BackingOption = {
      stock: EQUITIES.find((e) => e.symbol === "AMZNc")!,
      freeRaw: 43_000_000n,
      freeUsd: 96.5612,
      cf: 0.7,
    };
    expect(freeShownUsd(amzn)).toBe(96.56);
    for (const typed of [96.56, 96.5612, 96.565]) {
      expect(isAllFree(amzn, typed)).toBe(true);
      expect(backingRawFor(amzn, typed)).toBe(amzn.freeRaw);
    }
    expect(isAllFree(amzn, 96.55)).toBe(false);
    expect(backingRawFor(amzn, 96.55)).toBeLessThan(amzn.freeRaw);
    expect(isAllFree(amzn, 96.58)).toBe(false);
    expect(backingRawFor(amzn, 96.58)).toBeGreaterThan(amzn.freeRaw);
    expect(isAllFree(amzn, 0)).toBe(false);
    // A whole-cent free value: MAX's figure is the value itself.
    expect(freeShownUsd(nvdaFree)).toBe(2_000);
  });

  it("once it's all, a price move can't make it over-free or leave dust: the shares are what goes in", () => {
    // Sam types $96.56 of $96.5612 free (all of it, so the sheet keeps the free shares), then the price ticks down 0.06%.
    const amzn: BackingOption = {
      stock: EQUITIES.find((e) => e.symbol === "AMZNc")!,
      freeRaw: 43_000_000n,
      freeUsd: 96.5612,
      cf: 0.7,
    };
    const ticked = { ...amzn, freeUsd: 96.5 };
    const all = planCredit({
      position: fresh,
      backing: { option: ticked, raw: ticked.freeRaw },
      creditRaw: usd(10),
      cash: walletCash,
      now: weekday,
    });
    expect(all.block).toBeUndefined();
    expect(all.backing[0].raw).toBe(amzn.freeRaw);
    // Re-reading the same dollars at the new price would have been more than is free (what the sheet no longer does).
    expect(backingRawFor(ticked, 96.6)).toBeGreaterThan(ticked.freeRaw);
    // Shares worked out when typed stay those shares: $50 typed, then the price moves, still the same raw and within free.
    const half = backingRawFor(amzn, 50);
    const moved = planCredit({
      position: fresh,
      backing: { option: ticked, raw: half },
      creditRaw: usd(10),
      cash: walletCash,
      now: weekday,
    });
    expect(moved.backing[0].raw).toBe(half);
    expect(moved.block).toBeUndefined();
  });

  it("never more than is free: more is blocked, and the plan never puts in more than the free shares", () => {
    const over = withBacking(2_500, 10);
    expect(backingRawFor(nvdaFree, 2_500)).toBeGreaterThan(nvdaFree.freeRaw);
    expect(over.block).toBe("over-free");
    expect(over.backing[0].raw).toBe(nvdaFree.freeRaw);
    expect(creditBuyStop(over, true)).toBe(CREDIT_BLOCKED["over-free"]);
    // Nothing free at all.
    expect(
      planCredit({ position: backed, backing: { option: null, raw: 1n }, creditRaw: usd(10), cash: walletCash }).block,
    ).toBe("over-free");
    expect(backingRawFor(nvdaFree, 0)).toBe(0n);
    expect(backingRawFor(nvdaFree, Number.NaN)).toBe(0n);
  });

  it("0 backing uses only what already backs credit", () => {
    const none = withBacking(0, 100, backed);
    expect(none.backing).toEqual([]);
    expect(none.maxUsd).toBe(creditWith(backed)); // 1,000 × 0.7 ÷ 1.12 − 300
    expect(none.maxUsd).toBe(325);
    expect(none.block).toBeUndefined();
    expect(withBacking(0, 100, backed, null).maxUsd).toBe(325);
    // With nothing backing credit yet, 0 gives no room at all.
    expect(withBacking(0, 5).maxUsd).toBe(0);
    expect(withBacking(0, 5).block).toBe("act"); // nothing backs it: it would start in Act
    // Existing backing and the typed backing add up.
    expect(withBacking(500, 0, backed).maxUsd).toBe(637.5); // (700 + 350) ÷ 1.12 − 300
  });

  it("the D2 tick: Safe within what keeps it Safe, the extra confirmation past it, a block past the MAX and into Act", () => {
    // $1,000 of NVIDIA counts for $700: Safe up to $466, the cap at $625 (1.12), Watch to $636, Act past it.
    expect(withBacking(1_000, 400)).toMatchObject({ after: "safe", extraConfirm: false });
    expect(withBacking(1_000, 500)).toMatchObject({ after: "watch", extraConfirm: true });
    expect(withBacking(1_000, 650)).toMatchObject({ after: "act", extraConfirm: false, block: "act" });
    expect(withBacking(1_000, 625)).toMatchObject({ after: "watch", extraConfirm: true, block: undefined });
    expect(withBacking(1_000, 625.01)).toMatchObject({ after: "watch", block: "too-much" });
    expect(withBacking(1_000, 0).extraConfirm).toBe(false);
    expect(creditBuyStop(withBacking(1_000, 500), false)).toMatch(/credit in Watch/);
  });

  it("the status before → after with the backing alone: putting stock in use lifts a position", () => {
    const watching: CreditPosition = {
      ...fresh,
      totalBackingUsd: 1_000,
      avgCf: 0.7,
      debtUsd: 550,
      healthFactor: 700 / 550,
    };
    const p = withBacking(500, 0, watching);
    expect(p.before).toBe("watch");
    expect(p.after).toBe("safe"); // (700 + 350) / 550 = 1.91
    expect(withBacking(0, 0).after).toBe("none");
  });

  it("step 2's figure is step 4's: the room doesn't depend on the credit typed", () => {
    expect(withBacking(500, 300).maxUsd).toBe(withBacking(500, 0).maxUsd);
  });

  it("carries the batch's limit: the backing's free shares and the most credit it allows", () => {
    expect(withBacking(500, 300).limit).toEqual({ maxCreditRaw: usd(312.5), freeRaw: { NVDAc: nvdaFree.freeRaw } });
    expect(withBacking(0, 100, backed).limit).toEqual({ maxCreditRaw: usd(325), freeRaw: {} });
    // Auto mode: the room with exactly the backing autoFill puts in.
    const auto = planCredit({
      position: fresh,
      options: [nvdaFree],
      creditRaw: usd(300),
      cash: walletCash,
      now: weekday,
    });
    expect(toUsdc(auto.limit.maxCreditRaw)).toBeGreaterThanOrEqual(300);
    expect(auto.limit.freeRaw).toEqual({ NVDAc: nvdaFree.freeRaw });
  });
});

describe("the explicit backing in the batch (buildCreditBuyCalls, assertCreditBuy, the allowlist)", () => {
  const fresh: CreditPosition = {
    totalBackingUsd: 0,
    avgCf: 0,
    debtUsd: 0,
    healthFactor: null,
    usdcLiquidity: 1_000_000,
    creditPaused: false,
  };
  const nvdaFree: BackingOption = { stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 };
  const plan = planCredit({
    position: fresh,
    backing: { option: nvdaFree, raw: backingRawFor(nvdaFree, 500) },
    creditRaw: quote.amountIn,
    cash: walletCash,
  });
  const build = (over: Partial<Parameters<typeof buildCreditBuyCalls>[0]> = {}) =>
    buildCreditBuyCalls({
      user,
      stock: aapl,
      quote,
      creditRaw: plan.creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash: walletCash,
      nowSec: 1_000,
      ...over,
    });
  const review = { stock: aapl, creditRaw: quote.amountIn, cashRaw: 0n, backing: plan.backing, limit: plan.limit };

  it("puts exactly the typed backing in use → takes the credit → exact approve → swap, all allowed", () => {
    const calls = build();
    expect(steps(calls)).toEqual(["approve", "supply", "setUsingAsCollateral", "borrow", "approve", "swap"]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([AAVE.SPOKE, 280_000_000n]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[1].data }).args).toEqual([5n, 280_000_000n, user]);
    expect(assertAllowed(user, calls)).toBe(calls);
  });

  it("blocks more credit than the backing allows, even when the batch is otherwise right", () => {
    const tight = { ...plan.limit, maxCreditRaw: quote.amountIn - 1n };
    expect(() => build({ limit: tight })).toThrow(/more credit than the backing allows/);
    expect(plan.limit.maxCreditRaw).toBeGreaterThanOrEqual(quote.amountIn);
  });

  it("blocks more backing than the free shares, or a stock the screen didn't read", () => {
    expect(() => build({ limit: { ...plan.limit, freeRaw: { NVDAc: 279_999_999n } } })).toThrow(
      /more backing than the free shares/,
    );
    expect(() => build({ limit: { ...plan.limit, freeRaw: {} } })).toThrow(/more backing than the free shares/);
    expect(() => build({ backing: [{ stock: msft, raw: 1n }] })).toThrow(/more backing than the free shares/);
  });

  it("blocks a batch whose backing differs from the review: other amount, another account, extra or missing, after the credit, a bigger approve", () => {
    const calls = build();
    expect(() => assertCreditBuy(user, calls, { ...review, backing: [{ stock: nvda, raw: 1n }] })).toThrow(
      /backing differs/,
    );
    expect(() => assertCreditBuy(user, calls, { ...review, backing: [] })).toThrow(/backing differs/);
    const noBacking = build({ backing: [] });
    expect(() => assertCreditBuy(user, noBacking, review)).toThrow(/backing differs/);
    const theirs = {
      ...calls[1],
      data: encodeFunctionData({ abi: spokeAbi, functionName: "supply", args: [5n, 280_000_000n, attacker] }),
    };
    expect(() => assertCreditBuy(user, [calls[0], theirs, ...calls.slice(2)], review)).toThrow(/backing differs/);
    const [approve, supply, collateral, creditCall, usdcApprove, swap] = calls;
    expect(() => assertCreditBuy(user, [creditCall, approve, supply, collateral, usdcApprove, swap], review)).toThrow(
      /backing differs/,
    );
    const bigger = {
      ...approve,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, 280_000_001n] }),
    };
    expect(() => assertCreditBuy(user, [bigger, ...calls.slice(1)], review)).toThrow(/backing's approval differs/);
    expect(assertCreditBuy(user, calls, review)).toBe(calls);
  });

  it("the allowlist refuses backing put in use for someone else", () => {
    const calls = build();
    const theirs = {
      ...calls[1],
      data: encodeFunctionData({ abi: spokeAbi, functionName: "supply", args: [5n, 280_000_000n, attacker] }),
    };
    expect(() => assertAllowed(user, [calls[0], theirs])).toThrow(/unexpected arguments to supply/);
  });

  it("records exactly the typed backing in Activity", () => {
    expect(creditBuyActivity({ stock: aapl, quote, plan })[0]).toEqual({
      kind: "supply",
      symbol: "NVDAc",
      amount: 2.8,
    });
  });
});

describe("Act is the line (Adrian, 2026-10-15): every way of taking credit may end in Watch, never in Act", () => {
  const fresh: CreditPosition = {
    totalBackingUsd: 0,
    avgCf: 0,
    debtUsd: 0,
    healthFactor: null,
    usdcLiquidity: 1_000_000,
    creditPaused: false,
  };
  const at = (totalBackingUsd: number, avgCf: number, debtUsd: number): CreditPosition => ({
    ...fresh,
    totalBackingUsd,
    avgCf,
    debtUsd,
    healthFactor: debtUsd > 0 ? (totalBackingUsd * avgCf) / debtUsd : null,
  });
  const opt = (stock: typeof nvda, freeUsd: number, cf: number): BackingOption => ({
    stock,
    freeRaw: BigInt(Math.round(freeUsd * 1e6)),
    freeUsd,
    cf,
  });
  const nvdaFree = opt(nvda, 2_000, 0.7);
  const msftFree = opt(msft, 500, 0.78);
  const power = (pos: CreditPosition, options: BackingOption[]) =>
    pos.totalBackingUsd * pos.avgCf + options.reduce((a, o) => a + o.freeUsd * o.cf, 0);

  it("the cap's line is the Act line plus 0.02, in Watch, and lives next to the bands", () => {
    expect(CREDIT_CAP.minHf).toBe(1.12);
    expect(CREDIT_CAP.minHf).toBeCloseTo(RISK.watchMin + CREDIT_CAP.marginHf, 12);
    expect(statusFor(CREDIT_CAP.minHf)).toBe("watch");
    // One price update between reading and signing: 99% of the falls measured were 0.80% or less, 99.9% 1.10% or less.
    // From the cap they stay in Watch; a 1.8% fall reaches Act (the measured worst single update was −2.13%).
    expect(statusFor(CREDIT_CAP.minHf * (1 - 0.008))).toBe("watch");
    expect(statusFor(CREDIT_CAP.minHf * (1 - 0.011))).toBe("watch");
    expect(statusFor(CREDIT_CAP.minHf * (1 - 0.018))).toBe("act");
  });

  it("is health 1.12 at the cap, across collateral factors, existing debt and several backings", () => {
    const cases: { pos: CreditPosition; options: BackingOption[] }[] = [
      { pos: fresh, options: [nvdaFree] },
      { pos: fresh, options: [opt(aapl, 1_000, 0.78)] },
      { pos: fresh, options: [opt(meta, 1_234.56, 0.65)] },
      { pos: fresh, options: [opt(nvda, 3_333.33, 0.5)] },
      { pos: at(5_000, 0.74, 1_800), options: [opt(nvda, 700, 0.7)] },
      { pos: at(5_000, 0.74, 1_800), options: [opt(nvda, 700, 0.7), msftFree, opt(aapl, 50, 0.78)] },
      // In Watch under the line: only new backing makes room, and first covers what the credit already needs.
      { pos: at(1_000, 0.7, 630), options: [nvdaFree] },
    ];
    for (const { pos, options } of cases) {
      const cap = power(pos, options) / 1.12 - pos.debtUsd;
      const p0 = planCredit({ position: pos, options, creditRaw: 0n, cash: walletCash });
      expect(p0.maxUsd).toBeLessThanOrEqual(cap + 1e-9);
      expect(p0.maxUsd).toBeGreaterThan(cap - 0.01);
      // At the cap, to the cent: everything goes in (several backings), it ends in Watch with the tick, and no further.
      const top = planCredit({ position: pos, options, creditRaw: usd(p0.maxUsd), cash: walletCash });
      expect(top.block).toBeUndefined();
      expect(top.backing.map((b) => b.raw)).toEqual(options.map((o) => o.freeRaw));
      expect(top.after).toBe("watch");
      expect(top.extraConfirm).toBe(true);
      expect(top.hfAfter).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 1e-9);
      expect(planCredit({ position: pos, options, creditRaw: usd(p0.maxUsd + 0.01), cash: walletCash }).block).toBe(
        "too-much",
      );
      // The explicit pick gives the same cap with that one option.
      if (options.length === 1) {
        expect(
          planCredit({
            position: pos,
            backing: { option: options[0], raw: options[0].freeRaw },
            creditRaw: 0n,
            cash: walletCash,
          }).maxUsd,
        ).toBe(p0.maxUsd);
      }
    }
    // Under the line with nothing new in use: no room at all.
    expect(creditWith(at(1_000, 0.7, 630))).toBe(0);
  });

  it("a plan that ends in Act is blocked with one plain line, and no tick lets it through; Watch goes ahead with the tick", () => {
    const watch = planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(1_200), cash: walletCash });
    expect(watch).toMatchObject({ after: "watch", extraConfirm: true, block: undefined });
    expect(creditBuyStop(watch, false)).toBe("Confirm you understand this puts your credit in Watch first.");
    expect(creditBuyStop(watch, true)).toBeNull();
    for (const p of [
      planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(1_300), cash: walletCash }),
      planCredit({
        position: fresh,
        backing: { option: nvdaFree, raw: nvdaFree.freeRaw },
        creditRaw: usd(1_300),
        cash: walletCash,
      }),
    ]) {
      expect(p).toMatchObject({ after: "act", block: "act", extraConfirm: false });
      expect(creditBuyStop(p, true)).toBe(CREDIT_BLOCKED.act);
      expect(CREDIT_BLOCKED.act).toBe("That would put your credit in Act. Try a smaller amount.");
      // No limit lets the batch past the cap either.
      expect(toUsdc(p.limit.maxCreditRaw)).toBeLessThanOrEqual(1_250);
    }
  });

  it("in Act already: no more credit, however much new backing goes in; backing alone still goes in", () => {
    const inAct = at(1_000, 0.7, 660); // 1.06
    expect(statusFor(inAct.healthFactor)).toBe("act");
    expect(creditCap(inAct, [{ key: "NVDAc", usd: 2_000, cf: 0.7, freeUsd: 2_000 }])).toEqual({
      maxUsd: 0,
      maxSafeUsd: 0,
    });
    const pick = planCredit({
      position: inAct,
      backing: { option: nvdaFree, raw: nvdaFree.freeRaw },
      creditRaw: usd(10),
      cash: walletCash,
    });
    expect(pick.block).toBe("in-act");
    expect(creditBuyStop(pick, true)).toBe(CREDIT_BLOCKED["in-act"]);
    // Decision 1 and Earn with stocks (autoFill) too.
    expect(planCredit({ position: inAct, options: [nvdaFree], creditRaw: usd(10), cash: walletCash }).block).toBe(
      "in-act",
    );
    // Putting stock in use on its own lifts it, and is no block.
    const backingOnly = planCredit({
      position: inAct,
      backing: { option: nvdaFree, raw: nvdaFree.freeRaw },
      creditRaw: 0n,
      cash: walletCash,
    });
    expect(backingOnly.block).toBeUndefined();
    expect(backingOnly.after).toBe("safe");
    expect(creditAvailable({ position: inAct, options: [nvdaFree], cash: walletCash, holdsStock: true })).toMatchObject(
      { usd: 0, why: "in-act" },
    );
    expect(noCreditLine("in-act", true)).toBe(
      "Your credit is in Act. Repay some to use more. You can still buy with cash.",
    );
  });

  it("one number: Invest's buying power, step 1's pick, step 2's figure, step 3's headline, step 4's MAX and Up to, and Home's Available", () => {
    const backed = at(1_000, 0.7, 300);
    const options = [msftFree, nvdaFree];
    const headline = creditAvailable({ position: backed, options, cash: walletCash, holdsStock: true }).usd;
    const best = bestBacking(backed, options)!;
    const all = { option: best.option, raw: best.option.freeRaw };
    const step2 = planCredit({ position: backed, backing: all, creditRaw: 0n, cash: walletCash });
    const step4 = planCredit({
      position: backed,
      backing: all,
      creditRaw: usd(Math.floor(step2.maxUsd)),
      cash: walletCash,
    });
    expect(headline).toBe(1_575); // (700 + 1,400) ÷ 1.12 − 300
    expect(best.usd).toBe(headline);
    expect(step2.maxUsd).toBe(headline);
    expect(step4.maxUsd).toBe(headline);
    expect(step4.block).toBeUndefined();
    expect(planCredit({ position: backed, backing: all, creditRaw: usd(headline), cash: walletCash })).toMatchObject({
      after: "watch",
      block: undefined,
    });
    expect(
      planCredit({ position: backed, backing: all, creditRaw: usd(headline + 0.01), cash: walletCash }).block,
    ).toBe("too-much");
    expect(toUsdc(step4.limit.maxCreditRaw)).toBe(headline);
    // usePosition's availableUsd (what the old Credit sheet called "Available") is the same cap on what already backs credit.
    expect(creditWith(backed)).toBe(creditCap(backed).maxUsd);
    expect(creditWith(backed)).toBe(325);
  });

  it("the leverage loop: Credit Buys backed by what the last one bought converge at the cap and never reach Act", () => {
    for (const cf of [0.5, 0.65, 0.7, 0.78]) {
      let pos: CreditPosition = fresh;
      let freeUsd = 1_000;
      let buys = 0;
      for (; buys < 200; buys++) {
        const option = opt(nvda, freeUsd, cf);
        const pick = { option, raw: option.freeRaw };
        // Step 4's MAX, in whole dollars, as Sam would tap it.
        const max = Math.floor(planCredit({ position: pos, backing: pick, creditRaw: 0n, cash: walletCash }).maxUsd);
        if (max < BUY_LIMITS.minUsd) break;
        const plan = planCredit({ position: pos, backing: pick, creditRaw: usd(max), cash: walletCash });
        expect(plan.block).toBeUndefined();
        expect(plan.after).not.toBe("act");
        expect(plan.hfAfter).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 1e-9);
        // It lands: the free stock backs credit, the credit is owed, and it bought the same stock, free now.
        const totalBackingUsd = pos.totalBackingUsd + freeUsd;
        const backs = pos.totalBackingUsd * pos.avgCf + freeUsd * cf;
        const debtUsd = pos.debtUsd + max;
        pos = { ...pos, totalBackingUsd, avgCf: backs / totalBackingUsd, debtUsd, healthFactor: backs / debtUsd };
        freeUsd = max;
      }
      // It stops on its own: each buy is cf ÷ 1.12 of the last, so what's owed tends to 1,000 × r ÷ (1 − r).
      const r = cf / CREDIT_CAP.minHf;
      const limit = (1_000 * r) / (1 - r);
      expect(buys).toBeLessThan(60);
      expect(pos.debtUsd).toBeLessThanOrEqual(limit);
      expect(pos.debtUsd).toBeGreaterThan(limit * 0.97);
      expect(pos.healthFactor!).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 1e-9);
      expect(statusFor(pos.healthFactor)).toBe("watch");
      // Backing the last buy too leaves less than a whole dollar, the smallest MAX Sam taps.
      const last = opt(nvda, freeUsd, cf);
      expect(
        planCredit({ position: pos, backing: { option: last, raw: last.freeRaw }, creditRaw: 0n, cash: walletCash })
          .maxUsd,
      ).toBeLessThan(1);
    }
  });

  it("Free up stops at the same line: its MAX leaves health at 1.12, and Aave's own limit would have reached Act", () => {
    const pos = { totalBackingUsd: 2_000, avgCf: 0.7, debtUsd: 800 }; // 1.75
    const max = maxWithdrawUsd({ ...pos, cf: 0.7, backingUsd: 2_000, targetHf: CREDIT_CAP.minHf });
    expect(max).toBeCloseTo((1_400 - 800 * 1.12) / 0.7, 9);
    expect(healthAfterWithdraw({ ...pos, cf: 0.7, usd: max })).toBeCloseTo(1.12, 9);
    expect(statusFor(healthAfterWithdraw({ ...pos, cf: 0.7, usd: max }))).toBe("watch");
    // What the sheet allowed before: 99.5% of Aave's limit, deep in Act.
    const aave = maxWithdrawUsd({ ...pos, cf: 0.7, backingUsd: 2_000 });
    expect(statusFor(healthAfterWithdraw({ ...pos, cf: 0.7, usd: aave * 0.995 }))).toBe("act");
    // Under the line already: nothing can be freed while something is owed.
    expect(
      maxWithdrawUsd({
        totalBackingUsd: 1_000,
        avgCf: 0.7,
        debtUsd: 630,
        cf: 0.7,
        backingUsd: 1_000,
        targetHf: CREDIT_CAP.minHf,
      }),
    ).toBe(0);
  });

  it("its words keep D17's and protocol words off screen", () => {
    for (const line of [CREDIT_BLOCKED.act, CREDIT_BLOCKED["in-act"], NO_CREDIT["in-act"]])
      expect(line).not.toMatch(/creditCall|loan|lock|aave|collateral|health/i);
  });
});

import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256, parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { assertAllowed, swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { FILL_MARGIN, fillRaw } from "@/lib/aave/loan";
import { buildBorrowCalls } from "@/lib/aave/tx";
import { payFromCash } from "@/lib/cash";
import {
  CREDIT_BLOCKED, CREDIT_FROM, FEE_FIRST, NO_CREDIT, assertCreditBuy, backers, backingOptions, backingRaw, bestBacking, buildCreditBuyCalls, creditAvailable,
  creditBuyActivity, creditBuyStop, creditWith, noCreditLine, planCredit, shortNames, splitCash,
  type BackingOption, type CreditLimit, type CreditPosition,
} from "@/lib/creditBuy";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { buildBuyCalls, minOut, type BuyQuote } from "@/lib/swap/buy";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const attacker: `0x${string}` = "0x00000000000000000000000000000000000000ee";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const toUsdc = (raw: bigint) => Number(raw) / 1e6;
const fee = usd(CASH.feeBufferUsd);
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const msft = EQUITIES.find((e) => e.symbol === "MSFTc")!;
const meta = EQUITIES.find((e) => e.symbol === "METAc")!;
const quote: BuyQuote = { venue: "aerodrome", pool: 10, amountIn: usd(300), amountOut: 135_000_000n }; // $300 → 1.35 AAPLc
const walletCash = { walletRaw: usd(40), savingsRaw: 0n, saveOn: true };
/** A limit that doesn't bite: for the tests about the batch's shape. */
const roomy: CreditLimit = { maxCreditRaw: usd(1_000_000), freeRaw: { NVDAc: 10n ** 12n } };
const fn = (data: `0x${string}`) => decodeFunctionData({ abi: [...erc20Abi, ...spokeAbi, ...aaveV3PoolAbi], data }).functionName;
const steps = (calls: { data: `0x${string}`; to: `0x${string}` }[]) => calls.map((c) => (swapOf(c) ? "swap" : fn(c.data)));

describe("buildCreditBuyCalls (plan item 3)", () => {
  it("first-time backing: put the stock in use → take credit → approve → swap, in that order", () => {
    const calls = buildCreditBuyCalls({ limit: roomy, user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [{ stock: nvda, raw: 336_000_000n }], cash: walletCash, nowSec: 1_000 });
    expect(steps(calls)).toEqual(["approve", "supply", "setUsingAsCollateral", "borrow", "approve", "swap"]);
    expect(calls.map((c) => c.to)).toEqual([nvda.address, AAVE.SPOKE, AAVE.SPOKE, AAVE.SPOKE, USDC.address, AERODROME.ROUTER]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[1].data }).args).toEqual([5n, 336_000_000n, user]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[3].data }).args).toEqual([7n, usd(300), user]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[4].data }).args).toEqual([AERODROME.ROUTER, usd(300)]);
    const { params } = swapOf(calls[5])!;
    expect(params).toMatchObject({ tokenIn: USDC.address, tokenOut: aapl.address, recipient: user, amountIn: usd(300) });
    expect((params as unknown as { amountOutMinimum: bigint }).amountOutMinimum).toBe(minOut(quote.amountOut));
  });

  it("already backing: take credit → approve → swap, nothing else", () => {
    const calls = buildCreditBuyCalls({ limit: roomy, user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: walletCash });
    expect(steps(calls)).toEqual(["borrow", "approve", "swap"]);
  });

  it("the network fee comes from cash: a $0 wallet takes just the fee buffer out of savings first", () => {
    const calls = buildCreditBuyCalls({ limit: roomy, user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: { walletRaw: 0n, savingsRaw: usd(100), saveOn: true } });
    expect(steps(calls)).toEqual(["withdraw", "borrow", "approve", "swap"]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, fee, user]);
  });

  it("Uniswap route: the swap sits in multicall with its deadline, and is still checked", () => {
    const uni = { ...quote, venue: "uniswap" as const, pool: 3000 };
    const calls = buildCreditBuyCalls({ limit: roomy, user, stock: aapl, quote: uni, creditRaw: uni.amountIn, backing: [], cash: walletCash });
    expect(calls.map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, UNISWAP.SWAP_ROUTER_02]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1].data }).args).toEqual([UNISWAP.SWAP_ROUTER_02, usd(300)]);
  });

  it("refuses a buy that doesn't spend the credit, no credit, a stock that isn't one of the 7, and cash short of the fee", () => {
    const base = { user, stock: aapl, quote, backing: [], limit: roomy, cash: walletCash };
    expect(() => buildCreditBuyCalls({ ...base, creditRaw: quote.amountIn + 1n })).toThrow(/Credit must be part of the buy/);
    expect(() => buildCreditBuyCalls({ ...base, creditRaw: 0n })).toThrow(/Credit must be part of the buy/);
    expect(() => buildCreditBuyCalls({ ...base, stock: USDC, creditRaw: quote.amountIn })).toThrow(/Not a supported stock/);
    expect(() => buildCreditBuyCalls({ ...base, creditRaw: quote.amountIn, cash: { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true } })).toThrow(/More than your cash/);
  });
});

describe("decision 1: more than your cash", () => {
  it("splitCash: cash pays all it can (less the fee buffer), credit the other part", () => {
    const cash = { walletRaw: usd(40), savingsRaw: usd(60), saveOn: true };
    expect(splitCash(usd(80), cash)).toEqual({ cashRaw: usd(80), creditRaw: 0n });
    expect(splitCash(usd(300), cash)).toEqual({ cashRaw: usd(100) - fee, creditRaw: usd(200) + fee });
    expect(splitCash(usd(5), { walletRaw: fee / 2n, savingsRaw: 0n, saveOn: true })).toEqual({ cashRaw: 0n, creditRaw: usd(5) });
  });

  it("one batch: withdraw savings → put backing in use → take credit for the rest → approve → swap", () => {
    const cash = { walletRaw: 0n, savingsRaw: usd(100), saveOn: true };
    const { cashRaw, creditRaw } = splitCash(quote.amountIn, cash);
    const calls = buildCreditBuyCalls({ limit: roomy, user, stock: aapl, quote, creditRaw, backing: [{ stock: nvda, raw: 1n }], cash });
    expect(steps(calls)).toEqual(["withdraw", "approve", "supply", "setUsingAsCollateral", "borrow", "approve", "swap"]);
    // All of savings comes out (max uint): they are the last of the cash.
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, maxUint256, user]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[4].data }).args[1]).toBe(creditRaw);
    expect(swapOf(calls[6])!.params.amountIn).toBe(cashRaw + creditRaw);
    expect(cashRaw + creditRaw).toBe(quote.amountIn);
  });
});

describe("assertCreditBuy (the batch against the review)", () => {
  const review = { stock: aapl, creditRaw: quote.amountIn, cashRaw: 0n, backing: [], limit: roomy };
  const good = () => buildCreditBuyCalls({ limit: roomy, user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: walletCash });

  it("passes the builder's batch", () => {
    const calls = good();
    expect(assertCreditBuy(user, calls, review)).toBe(calls);
  });
  it("blocks credit or a swap that differs from the review", () => {
    expect(() => assertCreditBuy(user, good(), { ...review, creditRaw: quote.amountIn - 1n })).toThrow(/credit differs/);
    expect(() => assertCreditBuy(user, good(), { ...review, cashRaw: 1n })).toThrow(/credit differs|swap differs/);
    expect(() => assertCreditBuy(user, good(), { ...review, stock: msft })).toThrow(/swap differs/);
  });
  it("blocks another account's batch", () => {
    const theirs = buildCreditBuyCalls({ limit: roomy, user: attacker, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: walletCash });
    expect(() => assertCreditBuy(user, theirs, review)).toThrow(/credit differs/);
  });
  it("blocks a batch out of order, with a second credit or swap, or without its approve", () => {
    const [borrow, approve, swap] = good();
    expect(() => assertCreditBuy(user, [approve, swap, borrow], review)).toThrow(/swap must come last/);
    expect(() => assertCreditBuy(user, [borrow, ...buildBorrowCalls({ user, amountRaw: 1n }), approve, swap], review)).toThrow(/once/);
    expect(() => assertCreditBuy(user, [borrow, approve, swap, swap], review)).toThrow(/once/);
    expect(() => assertCreditBuy(user, [borrow], review)).toThrow(/once/);
    expect(() => assertCreditBuy(user, [approve, borrow, swap], review)).toThrow(/approval differs/);
    const [uniApprove] = buildBuyCalls({ user, stock: aapl, quote: { ...quote, venue: "uniswap", pool: 3000 } });
    expect(() => assertCreditBuy(user, [borrow, uniApprove, swap], review)).toThrow(/approval differs/);
  });
});

describe("payFromCash with nothing to pay but the fee", () => {
  const spend = buildBorrowCalls({ user, amountRaw: 1n });
  it("takes the fee buffer out of savings when the wallet can't cover it", () => {
    const calls = payFromCash(user, 0n, { walletRaw: 0n, savingsRaw: usd(10), saveOn: true }, spend);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, fee, user]);
    expect(payFromCash(user, 0n, { walletRaw: fee, savingsRaw: usd(10), saveOn: true }, spend)).toEqual(spend);
  });
  it("refuses when cash can't pay the fee", () => {
    expect(() => payFromCash(user, 0n, { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true }, spend)).toThrow(/More than your cash/);
  });
});

describe("planCredit (Leo's loan maths: autoFill, combinedLoan, status)", () => {
  // Sam: no credit yet, $2,000 of free NVIDIA (70% counts), $40 of cash.
  const fresh: CreditPosition = { collateralUsd: 0, avgCf: 0, debtUsd: 0, healthFactor: null, usdcLiquidity: 1_000_000, borrowPaused: false };
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
    expect(p.maxUsd).toBe(1393);
  });

  it("already backing: what backs credit covers it, so nothing new goes in", () => {
    const backed: CreditPosition = { ...fresh, collateralUsd: 9_000, avgCf: 0.73, debtUsd: 1_200, healthFactor: 5.4 };
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

  it("past Safe it puts everything in and asks for the extra confirmation (Watch or Act)", () => {
    const watch = plan(1_100);
    expect(watch.backing[0].raw).toBe(nvdaFree.freeRaw);
    expect(watch.after).toBe("watch");
    expect(watch.extraConfirm).toBe(true);
    expect(watch.block).toBeUndefined();
    const act = plan(1_350);
    expect(act.after).toBe("act");
    expect(act.extraConfirm).toBe(true);
  });

  it("blocks past the MAX, with no USDC to lend, when Aave pauses credit, or when cash can't pay the fee", () => {
    expect(plan(1_394).block).toBe("too-much");
    expect(plan(300, { ...fresh, usdcLiquidity: 299 }).block).toBe("no-liquidity");
    expect(plan(300, { ...fresh, borrowPaused: true }).block).toBe("paused");
    const broke = planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(300), cash: { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true }, now: weekday });
    expect(broke.block).toBe("fee");
  });

  it("weekends: allowed, and the review says the price may move (CLAUDE.md › Market hours)", () => {
    const p = plan(300, fresh, [nvdaFree], saturday);
    expect(p.block).toBeUndefined();
    expect(p.priceMayMove).toBe(true);
    expect(plan(300).priceMayMove).toBe(false);
  });
});

describe("creditAvailable (F2-3's \"You can use up to\")", () => {
  const fresh: CreditPosition = { collateralUsd: 0, avgCf: 0, debtUsd: 0, healthFactor: null, usdcLiquidity: 1_000_000, borrowPaused: false };
  const nvdaFree: BackingOption = { stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 };
  const msftFree: BackingOption = { stock: msft, freeRaw: 100_000_000n, freeUsd: 500, cf: 0.78 };
  const noCash = { walletRaw: fee - 1n, savingsRaw: 0n, saveOn: true };
  const avail = (position: CreditPosition, options: BackingOption[], holdsStock = true, cash = walletCash) =>
    creditAvailable({ position, options, cash, holdsStock });
  const perStock = (position: CreditPosition, o: BackingOption) => planCredit({ position, options: [o], creditRaw: 0n, cash: walletCash }).maxUsd;

  it("is the largest of F2-4's per-stock figures, not their sum: one buy is backed by one free holding", () => {
    expect(avail(fresh, [nvdaFree])).toEqual({ usd: 1_393, line: CREDIT_FROM }); // $2,000 × 70%, at 99.5% of the limit
    const both = avail(fresh, [msftFree, nvdaFree]);
    expect(both.usd).toBe(Math.max(perStock(fresh, nvdaFree), perStock(fresh, msftFree)));
    expect(both.usd).toBe(1_393);
  });

  it("creditWith is F2-4's per-stock figure: planCredit's MAX with that one option, or with none", () => {
    expect(creditWith(fresh, nvdaFree)).toBe(perStock(fresh, nvdaFree));
    expect(creditWith(fresh, msftFree)).toBe(perStock(fresh, msftFree));
    const backed: CreditPosition = { ...fresh, collateralUsd: 1_000, avgCf: 0.7, debtUsd: 300, healthFactor: 2.33 };
    expect(creditWith(backed)).toBe(planCredit({ position: backed, options: [], creditRaw: 0n, cash: walletCash }).maxUsd);
  });

  it("is what F2-4 picks first and F2-5 offers: the holding with the most free stock isn't always the one that backs the most", () => {
    // Live collateral factors differ by stock: $1,000 of Meta at 65% backs less than $900 of Microsoft at 79%.
    const metaFree: BackingOption = { stock: meta, freeRaw: 140_000_000n, freeUsd: 1_000, cf: 0.65 };
    const msft900: BackingOption = { stock: msft, freeRaw: 180_000_000n, freeUsd: 900, cf: 0.79 };
    const options = [metaFree, msft900]; // as the sheet sorts them: most free stock first
    const best = bestBacking(fresh, options)!;
    expect(best.option).toBe(msft900);
    const headline = avail(fresh, options).usd;
    expect(headline).toBe(707.44); // 900 × 79% × 99.5%, not Meta's $646.75
    // F2-5's "Up to" for the default pick is the plan with that one option.
    expect(planCredit({ position: fresh, options: [best.option], creditRaw: 0n, cash: walletCash }).maxUsd).toBe(headline);
    expect(best.usd).toBe(headline);
  });

  it("ties go to the most free stock, whatever the order", () => {
    const capped: CreditPosition = { ...fresh, usdcLiquidity: 100 }; // both hit what can be lent
    expect(bestBacking(capped, [msftFree, nvdaFree])!.option).toBe(nvdaFree);
    expect(bestBacking(capped, [nvdaFree, msftFree])!.option).toBe(nvdaFree);
    expect(bestBacking(fresh, [])).toBeNull();
  });

  it("counts what already backs credit, net of what's owed", () => {
    const backed: CreditPosition = { ...fresh, collateralUsd: 1_000, avgCf: 0.7, debtUsd: 300, healthFactor: 2.33 };
    // (1,000 × 0.7 + 2,000 × 0.7 − 300) × 99.5%
    expect(avail(backed, [nvdaFree]).usd).toBe(1_791);
    // Everything in use: the room on it alone.
    expect(avail(backed, [])).toEqual({ usd: 398, line: CREDIT_FROM });
  });

  it("never more than there is to lend", () => {
    expect(avail({ ...fresh, usdcLiquidity: 500 }, [nvdaFree]).usd).toBe(497.5);
  });

  it("with credit but less cash than the network fee, keeps the number and asks for the fee first (F2-5 would block every amount)", () => {
    const a = avail(fresh, [nvdaFree], true, noCash);
    expect(a).toEqual({ usd: 1_393, line: FEE_FIRST });
    expect(FEE_FIRST).toBe("Add $0.50 to your cash for the network fee first.");
    expect(planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(10), cash: noCash }).block).toBe("fee");
    // Just enough for the fee: the usual line.
    expect(avail(fresh, [nvdaFree], true, { walletRaw: fee, savingsRaw: 0n, saveOn: true }).line).toBe(CREDIT_FROM);
  });

  it("$0 with the reason: no stock, nothing that can back credit, everything in use, paused, nothing to lend", () => {
    expect(avail(fresh, [], false)).toEqual({ usd: 0, why: "no-stocks", line: noCreditLine("no-stocks", true) });
    expect(avail(fresh, [])).toMatchObject({ usd: 0, why: "cant-back" });
    const full: CreditPosition = { ...fresh, collateralUsd: 1_000, avgCf: 0.7, debtUsd: 700, healthFactor: 1 };
    expect(avail(full, [])).toMatchObject({ usd: 0, why: "all-in-use" });
    expect(avail({ ...fresh, borrowPaused: true }, [nvdaFree])).toMatchObject({ usd: 0, why: "paused" });
    expect(avail({ ...fresh, usdcLiquidity: 0 }, [nvdaFree])).toMatchObject({ usd: 0, why: "no-liquidity" });
  });

  it("under the minimum buy is $0: no Credit Buy fits in it", () => {
    const nearly: CreditPosition = { ...fresh, collateralUsd: 1_000, avgCf: 0.7, debtUsd: 699.5, healthFactor: 1 };
    expect(avail(nearly, [])).toMatchObject({ usd: 0, why: "all-in-use" });
  });

  it("at $0, says cash still buys, or to top up when cash can't pay the smallest buy and its fee", () => {
    expect(avail(fresh, [], false).line).toBe("Credit comes from the stocks you own. Buy one with cash first.");
    expect(avail(fresh, [], false, { walletRaw: 0n, savingsRaw: 0n, saveOn: false }).line).toBe(
      "Credit comes from the stocks you own. Top up, then buy one with cash.",
    );
    // $1.49: the $1 minimum buy plus the $0.50 fee doesn't fit.
    expect(avail(fresh, [], true, { walletRaw: usd(1.49), savingsRaw: 0n, saveOn: false }).line).toBe(
      "Your stocks can’t back credit right now. Top up to buy with cash.",
    );
    expect(avail(fresh, [], true, { walletRaw: usd(1.5), savingsRaw: 0n, saveOn: false }).line).toBe(
      "Your stocks can’t back credit right now. You can still buy with cash.",
    );
  });

  it("says why in plain words, without the words D17 keeps off screen or Aave's", () => {
    const lines = [
      CREDIT_FROM,
      FEE_FIRST,
      ...(Object.keys(NO_CREDIT) as (keyof typeof NO_CREDIT)[]).flatMap((why) => [noCreditLine(why, true), noCreditLine(why, false)]),
    ];
    for (const line of lines) expect(line).not.toMatch(/borrow|loan|lock|aave|collateral|health/i);
  });
});

describe("creditBuyStop and creditBuyActivity (what the hooks check and record)", () => {
  const position: CreditPosition = { collateralUsd: 0, avgCf: 0, debtUsd: 0, healthFactor: null, usdcLiquidity: 1_000_000, borrowPaused: false };
  const options: BackingOption[] = [{ stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 }];
  const plan = (creditUsd: number) => planCredit({ position, options, creditRaw: usd(creditUsd), cash: walletCash, now: new Date("2026-10-14T15:00:00Z") });

  it("lets a Safe plan through, and holds Watch or Act until it's confirmed", () => {
    expect(creditBuyStop(plan(300), false)).toBeNull();
    expect(creditBuyStop(plan(1_100), false)).toMatch(/credit in Watch/);
    expect(creditBuyStop(plan(1_100), true)).toBeNull();
  });
  it("a block stops it even when confirmed", () => {
    expect(creditBuyStop(plan(5_000), true)).toBe(CREDIT_BLOCKED["too-much"]);
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
  const h = (symbol: string, over: Partial<{ freeRaw: bigint; freeUsd: number; paused: boolean; frozen: boolean }> = {}) => ({
    symbol, freeRaw: 1n, freeUsd: 100, paused: false, frozen: false, ...over,
  });
  it("lists free stock with a collateral factor that isn't paused, frozen or dust", () => {
    const cfs = { AAPLc: 0.78, NVDAc: 0.7, MSFTc: 0.78, METAc: 0 };
    const opts = backingOptions([h("AAPLc"), h("NVDAc", { paused: true }), h("MSFTc", { freeUsd: 0.001 }), h("METAc"), h("TSLAc"), h("AMZNc", { frozen: true })], cfs);
    expect(opts.map((o) => [o.stock.symbol, o.cf])).toEqual([["AAPLc", 0.78]]);
  });
});

describe("what backs it, by name (the sheet's \"Against\" and \"Backed by\")", () => {
  const h = (symbol: string, name: string, lockedRaw = 0n) => ({ symbol, name, lockedRaw });
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
});

describe("planCredit with an explicit backing (Credit Buy goes backing first, Adrian 2026-10-15)", () => {
  // Sam: no credit yet, $2,000 of free NVIDIA (70% counts), $40 of cash.
  const fresh: CreditPosition = { collateralUsd: 0, avgCf: 0, debtUsd: 0, healthFactor: null, usdcLiquidity: 1_000_000, borrowPaused: false };
  const backed: CreditPosition = { ...fresh, collateralUsd: 1_000, avgCf: 0.7, debtUsd: 300, healthFactor: 2.33 };
  const nvdaFree: BackingOption = { stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 };
  const weekday = new Date("2026-10-14T15:00:00Z");
  const withBacking = (typedUsd: number, creditUsd = 0, position = fresh, option: BackingOption | null = nvdaFree) =>
    planCredit({ position, backing: { option, raw: option ? backingRaw(option, typedUsd) : 0n }, creditRaw: usd(creditUsd), cash: walletCash, now: weekday });

  it("the typed dollars become raw units in proportion to the free value, and exactly that goes in (no fill margin)", () => {
    expect(backingRaw(nvdaFree, 500)).toBe(280_000_000n); // a quarter of the free shares
    const p = withBacking(500, 300);
    expect(p.backing).toEqual([{ stock: nvda, raw: 280_000_000n, usd: 500 }]);
    // autoFill would have put in $645 (300 × 1.5 / 0.7 plus the margin); the pick is what Sam typed.
    expect(planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(300), cash: walletCash, now: weekday }).backing[0].usd).toBeCloseTo((300 * 1.5 * FILL_MARGIN) / 0.7, 0);
  });

  it("the credit limit grows with the backing: what it counts for, at 99.5% of the limit", () => {
    const limits = [0, 100, 500, 1_000, 2_000].map((u) => withBacking(u).maxUsd);
    expect(limits).toEqual([0, 69.65, 348.25, 696.5, 1_393]);
    expect(withBacking(500).maxSafeUsd).toBe(233.33); // 500 × 70% / 1.5
  });

  it("MAX is all the free shares exactly, and gives Invest's number (creditWith)", () => {
    expect(backingRaw(nvdaFree, nvdaFree.freeUsd)).toBe(nvdaFree.freeRaw);
    // Within half a cent of all of it is all of it: no dust left behind.
    expect(backingRaw(nvdaFree, 1_999.996)).toBe(nvdaFree.freeRaw);
    expect(backingRaw(nvdaFree, 1_999.99)).toBeLessThan(nvdaFree.freeRaw);
    const all = planCredit({ position: fresh, backing: { option: nvdaFree, raw: nvdaFree.freeRaw }, creditRaw: 0n, cash: walletCash });
    expect(all.backing[0].raw).toBe(nvdaFree.freeRaw);
    expect(all.maxUsd).toBe(creditWith(fresh, nvdaFree));
  });

  it("never more than is free: more is blocked, and the plan never puts in more than the free shares", () => {
    const over = withBacking(2_500, 10);
    expect(backingRaw(nvdaFree, 2_500)).toBeGreaterThan(nvdaFree.freeRaw);
    expect(over.block).toBe("over-free");
    expect(over.backing[0].raw).toBe(nvdaFree.freeRaw);
    expect(creditBuyStop(over, true)).toBe(CREDIT_BLOCKED["over-free"]);
    // Nothing free at all.
    expect(planCredit({ position: backed, backing: { option: null, raw: 1n }, creditRaw: usd(10), cash: walletCash }).block).toBe("over-free");
    expect(backingRaw(nvdaFree, 0)).toBe(0n);
    expect(backingRaw(nvdaFree, Number.NaN)).toBe(0n);
  });

  it("0 backing uses only what already backs credit", () => {
    const none = withBacking(0, 100, backed);
    expect(none.backing).toEqual([]);
    expect(none.maxUsd).toBe(creditWith(backed)); // (1,000 × 0.7 − 300) × 99.5%
    expect(none.maxUsd).toBe(398);
    expect(none.block).toBeUndefined();
    expect(withBacking(0, 100, backed, null).maxUsd).toBe(398);
    // With nothing backing credit yet, 0 gives no room at all.
    expect(withBacking(0, 5).maxUsd).toBe(0);
    expect(withBacking(0, 5).block).toBe("too-much");
    // Existing backing and the typed backing add up.
    expect(withBacking(500, 0, backed).maxUsd).toBe(746.25); // (700 + 350 − 300) × 99.5%
  });

  it("the D2 tick: Safe within what keeps it Safe, the extra confirmation past it, a block past the MAX", () => {
    // $1,000 of NVIDIA counts for $700: Safe up to $466, Watch to $636, Act past it.
    expect(withBacking(1_000, 400)).toMatchObject({ after: "safe", extraConfirm: false });
    expect(withBacking(1_000, 500)).toMatchObject({ after: "watch", extraConfirm: true });
    expect(withBacking(1_000, 650)).toMatchObject({ after: "act", extraConfirm: true });
    expect(withBacking(1_000, 696.5).block).toBeUndefined();
    expect(withBacking(1_000, 696.51).block).toBe("too-much");
    expect(withBacking(1_000, 0).extraConfirm).toBe(false);
    expect(creditBuyStop(withBacking(1_000, 500), false)).toMatch(/credit in Watch/);
  });

  it("the status before → after with the backing alone: putting stock in use lifts a position", () => {
    const watching: CreditPosition = { ...fresh, collateralUsd: 1_000, avgCf: 0.7, debtUsd: 550, healthFactor: 700 / 550 };
    const p = withBacking(500, 0, watching);
    expect(p.before).toBe("watch");
    expect(p.after).toBe("safe"); // (700 + 350) / 550 = 1.91
    expect(withBacking(0, 0).after).toBe("none");
  });

  it("step 2's figure is step 4's: the room doesn't depend on the credit typed", () => {
    expect(withBacking(500, 300).maxUsd).toBe(withBacking(500, 0).maxUsd);
  });

  it("carries the batch's limit: the backing's free shares and the most credit it allows", () => {
    expect(withBacking(500, 300).limit).toEqual({ maxCreditRaw: usd(348.25), freeRaw: { NVDAc: nvdaFree.freeRaw } });
    expect(withBacking(0, 100, backed).limit).toEqual({ maxCreditRaw: usd(398), freeRaw: {} });
    // Auto mode: the room with exactly the backing autoFill puts in.
    const auto = planCredit({ position: fresh, options: [nvdaFree], creditRaw: usd(300), cash: walletCash, now: weekday });
    expect(toUsdc(auto.limit.maxCreditRaw)).toBeGreaterThanOrEqual(300);
    expect(auto.limit.freeRaw).toEqual({ NVDAc: nvdaFree.freeRaw });
  });
});

describe("the explicit backing in the batch (buildCreditBuyCalls, assertCreditBuy, the allowlist)", () => {
  const fresh: CreditPosition = { collateralUsd: 0, avgCf: 0, debtUsd: 0, healthFactor: null, usdcLiquidity: 1_000_000, borrowPaused: false };
  const nvdaFree: BackingOption = { stock: nvda, freeRaw: 1_120_000_000n, freeUsd: 2_000, cf: 0.7 };
  const plan = planCredit({ position: fresh, backing: { option: nvdaFree, raw: backingRaw(nvdaFree, 500) }, creditRaw: quote.amountIn, cash: walletCash });
  const build = (over: Partial<Parameters<typeof buildCreditBuyCalls>[0]> = {}) =>
    buildCreditBuyCalls({ user, stock: aapl, quote, creditRaw: plan.creditRaw, backing: plan.backing, limit: plan.limit, cash: walletCash, nowSec: 1_000, ...over });
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
    expect(() => build({ limit: { ...plan.limit, freeRaw: { NVDAc: 279_999_999n } } })).toThrow(/more backing than the free shares/);
    expect(() => build({ limit: { ...plan.limit, freeRaw: {} } })).toThrow(/more backing than the free shares/);
    expect(() => build({ backing: [{ stock: msft, raw: 1n }] })).toThrow(/more backing than the free shares/);
  });

  it("blocks a batch whose backing differs from the review: other amount, another account, extra or missing, after the credit, a bigger approve", () => {
    const calls = build();
    expect(() => assertCreditBuy(user, calls, { ...review, backing: [{ stock: nvda, raw: 1n }] })).toThrow(/backing differs/);
    expect(() => assertCreditBuy(user, calls, { ...review, backing: [] })).toThrow(/backing differs/);
    const noBacking = build({ backing: [] });
    expect(() => assertCreditBuy(user, noBacking, review)).toThrow(/backing differs/);
    const theirs = { ...calls[1], data: encodeFunctionData({ abi: spokeAbi, functionName: "supply", args: [5n, 280_000_000n, attacker] }) };
    expect(() => assertCreditBuy(user, [calls[0], theirs, ...calls.slice(2)], review)).toThrow(/backing differs/);
    const [approve, supply, collateral, borrow, usdcApprove, swap] = calls;
    expect(() => assertCreditBuy(user, [borrow, approve, supply, collateral, usdcApprove, swap], review)).toThrow(/backing differs/);
    const bigger = { ...approve, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, 280_000_001n] }) };
    expect(() => assertCreditBuy(user, [bigger, ...calls.slice(1)], review)).toThrow(/backing's approval differs/);
    expect(assertCreditBuy(user, calls, review)).toBe(calls);
  });

  it("the allowlist refuses backing put in use for someone else", () => {
    const calls = build();
    const theirs = { ...calls[1], data: encodeFunctionData({ abi: spokeAbi, functionName: "supply", args: [5n, 280_000_000n, attacker] }) };
    expect(() => assertAllowed(user, [calls[0], theirs])).toThrow(/unexpected arguments to supply/);
  });

  it("records exactly the typed backing in Activity", () => {
    expect(creditBuyActivity({ stock: aapl, quote, plan })[0]).toEqual({ kind: "supply", symbol: "NVDAc", amount: 2.8 });
  });
});

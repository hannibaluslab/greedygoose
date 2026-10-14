import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, maxUint256, parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { FILL_MARGIN, fillRaw } from "@/lib/aave/loan";
import { buildBorrowCalls } from "@/lib/aave/tx";
import { payFromCash } from "@/lib/cash";
import {
  CREDIT_BLOCKED, assertCreditBuy, backers, backingOptions, buildCreditBuyCalls, creditBuyActivity, creditBuyStop, planCredit, shortNames, splitCash,
  type BackingOption, type CreditPosition,
} from "@/lib/creditBuy";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { buildBuyCalls, minOut, type BuyQuote } from "@/lib/swap/buy";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const attacker: `0x${string}` = "0x00000000000000000000000000000000000000ee";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const fee = usd(CASH.feeBufferUsd);
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const msft = EQUITIES.find((e) => e.symbol === "MSFTc")!;
const quote: BuyQuote = { venue: "aerodrome", pool: 10, amountIn: usd(300), amountOut: 135_000_000n }; // $300 → 1.35 AAPLc
const walletCash = { walletRaw: usd(40), savingsRaw: 0n, saveOn: true };
const fn = (data: `0x${string}`) => decodeFunctionData({ abi: [...erc20Abi, ...spokeAbi, ...aaveV3PoolAbi], data }).functionName;
const steps = (calls: { data: `0x${string}`; to: `0x${string}` }[]) => calls.map((c) => (swapOf(c) ? "swap" : fn(c.data)));

describe("buildCreditBuyCalls (plan item 3)", () => {
  it("first-time backing: put the stock in use → take credit → approve → swap, in that order", () => {
    const calls = buildCreditBuyCalls({ user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [{ stock: nvda, raw: 336_000_000n }], cash: walletCash, nowSec: 1_000 });
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
    const calls = buildCreditBuyCalls({ user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: walletCash });
    expect(steps(calls)).toEqual(["borrow", "approve", "swap"]);
  });

  it("the network fee comes from cash: a $0 wallet takes just the fee buffer out of savings first", () => {
    const calls = buildCreditBuyCalls({ user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: { walletRaw: 0n, savingsRaw: usd(100), saveOn: true } });
    expect(steps(calls)).toEqual(["withdraw", "borrow", "approve", "swap"]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, fee, user]);
  });

  it("Uniswap route: the swap sits in multicall with its deadline, and is still checked", () => {
    const uni = { ...quote, venue: "uniswap" as const, pool: 3000 };
    const calls = buildCreditBuyCalls({ user, stock: aapl, quote: uni, creditRaw: uni.amountIn, backing: [], cash: walletCash });
    expect(calls.map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, UNISWAP.SWAP_ROUTER_02]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1].data }).args).toEqual([UNISWAP.SWAP_ROUTER_02, usd(300)]);
  });

  it("refuses a buy that doesn't spend the credit, no credit, a stock that isn't one of the 7, and cash short of the fee", () => {
    const base = { user, stock: aapl, quote, backing: [], cash: walletCash };
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
    const calls = buildCreditBuyCalls({ user, stock: aapl, quote, creditRaw, backing: [{ stock: nvda, raw: 1n }], cash });
    expect(steps(calls)).toEqual(["withdraw", "approve", "supply", "setUsingAsCollateral", "borrow", "approve", "swap"]);
    // All of savings comes out (max uint): they are the last of the cash.
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, maxUint256, user]);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[4].data }).args[1]).toBe(creditRaw);
    expect(swapOf(calls[6])!.params.amountIn).toBe(cashRaw + creditRaw);
    expect(cashRaw + creditRaw).toBe(quote.amountIn);
  });
});

describe("assertCreditBuy (the batch against the review)", () => {
  const review = { stock: aapl, creditRaw: quote.amountIn, cashRaw: 0n };
  const good = () => buildCreditBuyCalls({ user, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: walletCash });

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
    const theirs = buildCreditBuyCalls({ user: attacker, stock: aapl, quote, creditRaw: quote.amountIn, backing: [], cash: walletCash });
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

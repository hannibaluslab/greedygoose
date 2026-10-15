import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseUnits, type Hex } from "viem";
import { CASH } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { assertAllowed, swapOf } from "@/lib/allowlist";
import type { Cash } from "@/lib/cash";
import {
  REPAY_COPY,
  REPAY_FORM,
  allText,
  minRepayUsd,
  noSourceLine,
  pickedSource,
  planRepay,
  quickPicks,
  repayForm,
  repayMax,
  repaySmallPrint,
  repaySources,
  sharesForRepay,
  statusAfter,
  type RepayData,
  type RepayForm,
  type RepayHolding,
  type RepaySource,
} from "@/lib/repay";
import { assertSaleCoversRepay, buildFreeRepayCalls, freeRepayRaw, saleRepayRaw } from "@/lib/sell";
import { freeRepayPlan, repaySign, type FreeRepayInput } from "@/hooks/useRepay";
import type { QuoteState } from "@/lib/trade";
import { minOut } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const attacker: `0x${string}` = "0x00000000000000000000000000000000000000ee";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const shares = (n: number) => parseUnits(n.toFixed(8), 8);
const fee = usd(CASH.feeBufferUsd);
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const tuesday = new Date("2026-10-13T15:00:00Z");

const holding = (symbol: string, name: string, priceUsd: number, free: number, locked: number, paused = false): RepayHolding => ({
  symbol,
  name,
  priceUsd,
  freeRaw: shares(free),
  lockedRaw: shares(locked),
  freeUsd: free * priceUsd,
  lockedUsd: locked * priceUsd,
  paused,
  multiplier: 10n ** 18n,
});

/**
 * $1,000 of NVIDIA backs $300 of credit (collateral factor 70%: health 2.33, Safe); 0.1 NVIDIA ($25) and 0.5 Apple
 * ($100) are free, and $0.40 of Microsoft. $100 of cash in the wallet.
 */
const data = (p: { debt?: number; wallet?: number; savings?: number; holdings?: RepayHolding[] } = {}): RepayData => {
  const debt = p.debt ?? 300;
  const cash: Cash = { walletRaw: usd(p.wallet ?? 100), savingsRaw: usd(p.savings ?? 0), saveOn: false };
  const healthFactor = debt > 0 ? 700 / debt : null;
  return {
    collateralUsd: 1_000,
    avgCf: 0.7,
    debtUsd: debt,
    debtRaw: usd(debt),
    healthFactor,
    status: healthFactor === null ? "none" : healthFactor >= 1.5 ? "safe" : healthFactor >= 1.1 ? "watch" : "act",
    cash,
    cashUsd: (p.wallet ?? 100) + (p.savings ?? 0),
    holdings: p.holdings ?? [
      holding("AAPLc", "Apple", 200, 0.5, 0),
      holding("MSFTc", "Microsoft", 400, 0.001, 0),
      holding("NVDAc", "NVIDIA", 250, 0.1, 4),
    ],
  };
};
const cfs = { NVDAc: 0.7, AAPLc: 0.78, MSFTc: 0.7 };
const ids = (s: RepaySource[]) => s.map((x) => x.id);
/** A pool that pays `perShare` dollars a share, whatever the size (or less per share for bigger sales, with `impact`). */
const quoteAt = (stockShares: bigint, perShare: number, impact = 0): SellQuote => {
  const n = Number(stockShares) / 1e8;
  return { venue: "aerodrome", pool: 10, amountIn: stockShares, amountOut: usd(n * perShare * (1 - impact * n)) };
};
const ready = (q: SellQuote): QuoteState<SellQuote> => ({ data: q, isFetching: false, isSuccess: true });
const fn = (data: Hex) => decodeFunctionData({ abi: [...erc20Abi, ...spokeAbi], data }).functionName;
const steps = (calls: { data: Hex; to: `0x${string}` }[]) => calls.map((c) => (swapOf(c) ? "swap" : fn(c.data)));
const repayArg = (calls: { data: Hex; to: `0x${string}` }[]) => {
  const c = calls.find((x) => x.to === AAVE.SPOKE && fn(x.data) === "repay")!;
  return decodeFunctionData({ abi: spokeAbi, data: c.data }).args[1] as bigint;
};

describe("Pay with: the rows, their order and who's listed", () => {
  it("cash first, then the stocks held free, then the stocks that back the credit, each by what it can repay", () => {
    const s = repaySources(data(), cfs);
    expect(ids(s)).toEqual(["cash", "free:AAPLc", "free:NVDAc", "backing:NVDAc"]);
    expect(s.map((x) => x.kind)).toEqual(["cash", "free", "free", "backing"]);
    expect(s.map((x) => x.sub)).toEqual(["$100.00 in your cash", "$100.00 free", "$25.00 free", "$1,000.00 backs your credit"]);
    // Cash less the fee buffer; a free stock at Aave's price less the swap's 1%; a backing stock capped at what's owed.
    expect(s[0].estUsd).toBeCloseTo(99.5, 6);
    expect(s[1].estUsd).toBeCloseTo(99, 6);
    expect(s[2].estUsd).toBeCloseTo(24.75, 6);
    expect(s[3].estUsd).toBe(300);
  });

  it("the cash is the default when it can repay $1; otherwise the first row", () => {
    expect(pickedSource(repaySources(data(), cfs), null)?.id).toBe("cash");
    expect(pickedSource(repaySources(data({ wallet: 1.4 }), cfs), null)?.id).toBe("free:AAPLc");
    // A picked row stays picked while it's listed, and falls back to the default once it isn't.
    expect(pickedSource(repaySources(data(), cfs), "backing:NVDAc")?.id).toBe("backing:NVDAc");
    expect(pickedSource(repaySources(data(), cfs), "free:TSLAc")?.id).toBe("cash");
  });

  it("hides every row that can't repay $1: the cash under $1.50, a free stock under about $1, dust", () => {
    expect(ids(repaySources(data({ wallet: 1.49 }), cfs))).not.toContain("cash");
    expect(ids(repaySources(data({ wallet: 1.5 }), cfs))).toContain("cash");
    expect(ids(repaySources(data(), cfs))).not.toContain("free:MSFTc");
    const tiny = data({ holdings: [holding("AAPLc", "Apple", 200, 0.005, 0)] }); // $1.00 free: $0.99 at its floor
    expect(ids(repaySources(tiny, cfs))).toEqual(["cash"]);
    // $1.01 free reaches $1 at Aave's price less 1%, but not with its pool up to 1% under: not offered.
    const edge = data({ holdings: [holding("AAPLc", "Apple", 200, 0.00505, 0)] });
    expect(ids(repaySources(edge, cfs))).toEqual(["cash"]);
    const enough = data({ holdings: [holding("AAPLc", "Apple", 200, 0.0052, 0)] }); // $1.04
    expect(ids(repaySources(enough, cfs))).toEqual(["cash", "free:AAPLc"]);
  });

  it("owing under $1, a row that repays all of it is listed", () => {
    const s = repaySources(data({ debt: 0.4, wallet: 0.95 }), cfs);
    expect(s[0].id).toBe("cash");
    expect(s[0].estUsd).toBe(0.4);
    expect(minRepayUsd(0.4)).toBe(0.4);
  });

  it("a free stock pays its own fee when the cash can't keep the buffer", () => {
    const s = repaySources(data({ wallet: 0.3 }), cfs);
    expect(ids(s)).toEqual(["free:AAPLc", "free:NVDAc", "backing:NVDAc"]);
    expect(s[0].feeFromSale).toBe(true);
    expect(s[0].estUsd).toBeCloseTo(99 - 0.5, 6);
    expect(repaySources(data(), cfs)[1].feeFromSale).toBe(false);
    // Backing always pays the fee from the sale (saleRepayRaw).
    expect(repaySources(data(), cfs)[3].feeFromSale).toBe(true);
  });

  it("a backing stock offers only the shares that can come out before the repay lands, and none while paused or unread", () => {
    const backing = repaySources(data(), cfs).find((x) => x.kind === "backing")!;
    // Room 700 − 300 = 400 → $571.43 of NVIDIA at 70%, 99.5% of it.
    expect(backing.maxSharesRaw).toBe((shares(4) * 568_571n) / 1_000_000n);
    expect(ids(repaySources(data(), undefined))).not.toContain("backing:NVDAc");
    const paused = data({ holdings: [holding("NVDAc", "NVIDIA", 250, 0, 4, true)] });
    expect(ids(repaySources(paused, cfs))).toEqual(["cash"]);
  });

  it("nothing owed lists nothing; nothing to pay with says to add money", () => {
    expect(repaySources(data({ debt: 0 }), cfs)).toEqual([]);
    const empty = data({ wallet: 0, holdings: [] });
    expect(repaySources(empty, cfs)).toEqual([]);
    expect(noSourceLine(empty)).toBe(REPAY_COPY.noCash);
    expect(noSourceLine(data({ wallet: 1.36, holdings: [holding("AAPLc", "Apple", 200, 0.004, 0)] }))).toBe(
      "You need $1.50 in your cash to repay: $0.50 of it stays for the network fee.",
    );
  });
});

describe("Amount: All by default, quick picks, never more than owed or than the row pays", () => {
  const cashOf = (d: RepayData) => repaySources(d, cfs)[0];

  it("cash: All is all of it less the fee, or a full repay when it covers what's owed", () => {
    const short = repayMax(cashOf(data()), data());
    expect(short).toMatchObject({ usd: 99.5, raw: usd(99.5), coversAll: false });
    expect(allText(short)).toBe("99.50");
    const d = data({ debt: 64.0042, wallet: 500 });
    const covers = repayMax(cashOf(d), d);
    expect(covers.coversAll).toBe(true);
    expect(covers.raw).toBe(usd(64.0042) + usd(64.0042) / 2000n + 1n);
    expect(allText(covers)).toBe("64.01"); // rounded up: never shown as less than what's owed
  });

  it("the sheet opens on All", () => {
    const d = data();
    const v = planRepay({ data: d, source: cashOf(d), form: REPAY_FORM });
    expect(v.all).toBe(true);
    expect(v.fieldText).toBe("99.50");
    expect(v.amountUsd).toBe(99.5);
    expect(v.oweAfterUsd).toBeCloseTo(200.5, 6);
    expect(v.ready).toBe(true);
    expect(v.fee).toBe(REPAY_COPY.feeFromCash);
  });

  it("quick picks are $25 and $50 while under the most the row repays, then All", () => {
    expect(quickPicks({ usd: 99.5, raw: 0n, coversAll: false, quoting: false })).toEqual([25, 50]);
    expect(quickPicks({ usd: 40, raw: 0n, coversAll: false, quoting: false })).toEqual([25]);
    expect(quickPicks({ usd: 4, raw: 0n, coversAll: true, quoting: false })).toEqual([]);
  });

  it("typed dollars or a pick at or over the most become All (NYM's clamp); under it they stay as typed", () => {
    const max = { usd: 99.5, raw: usd(99.5), coversAll: false, quoting: false };
    const f = (s: RepayForm, a: Parameters<typeof repayForm>[1]) => repayForm(s, a);
    expect(f(REPAY_FORM, { type: "amount", value: "40", max })).toEqual({ source: null, amount: "40", all: false });
    expect(f(REPAY_FORM, { type: "amount", value: "99.5", max })).toEqual({ source: null, amount: "", all: true });
    // More than the most snaps back to it, and says so.
    expect(f(REPAY_FORM, { type: "amount", value: "5000", max })).toEqual({ source: null, amount: "", all: true, snapped: true });
    expect(f(REPAY_FORM, { type: "chip", usd: 25, max })).toEqual({ source: null, amount: "25", all: false });
    expect(f({ source: "cash", amount: "40", all: false }, { type: "all" })).toEqual({ source: "cash", amount: "", all: true });
    // A new row starts on All again.
    expect(f({ source: "cash", amount: "40", all: false }, { type: "source", id: "free:AAPLc" })).toEqual({ source: "free:AAPLc", amount: "", all: true });
    // While the most is only an estimate (its quote is still coming), typing isn't snapped to it.
    expect(f(REPAY_FORM, { type: "amount", value: "5000", max: { ...max, quoting: true } }).all).toBe(false);
    // A key typed after the snap lands on the most again: the line stays.
    expect(f({ source: "cash", amount: "", all: true, snapped: true }, { type: "amount", value: "99.50", max })).toEqual({ source: "cash", amount: "", all: true, snapped: true });
    // Going under the most, or a pick, clears it.
    expect(f({ source: "cash", amount: "", all: true, snapped: true }, { type: "amount", value: "4", max })).toEqual({ source: "cash", amount: "4", all: false });
    expect(f({ source: "cash", amount: "", all: true, snapped: true }, { type: "all" })).toEqual({ source: "cash", amount: "", all: true });
  });

  it("snapping says in one plain line what the most is: all that's owed, the cash's most, or the stock's", () => {
    const d = data();
    const cash = cashOf(d);
    const over = repayForm(REPAY_FORM, { type: "amount", value: "5000", max: repayMax(cash, d) });
    const v = planRepay({ data: d, source: cash, form: over });
    expect(v.fieldText).toBe("99.50");
    expect(v.snapLine).toBe("That’s the most your cash can repay.");
    expect(v.note).toBeNull();
    const rich = data({ debt: 64, wallet: 500 });
    const all = planRepay({ data: rich, source: cashOf(rich), form: repayForm(REPAY_FORM, { type: "amount", value: "70", max: repayMax(cashOf(rich), rich) }) });
    expect(all.snapLine).toBe("That’s everything you owe.");
    expect(all.fieldText).toBe("64.00");
    // All picked, or the exact most typed, says nothing.
    expect(planRepay({ data: d, source: cash, form: REPAY_FORM }).snapLine).toBeNull();
    expect(planRepay({ data: d, source: cash, form: repayForm(REPAY_FORM, { type: "amount", value: "99.5", max: repayMax(cash, d) }) }).snapLine).toBeNull();
  });

  it("a cash amount repays exactly what's typed; under $1 says the smallest repay", () => {
    const d = data();
    const v = planRepay({ data: d, source: cashOf(d), form: { source: null, amount: "25", all: false } });
    expect(v.repayRaw).toBe(usd(25));
    expect(v.oweAfterUsd).toBe(275);
    expect(v.done).toBe("Repaid $25");
    const small = planRepay({ data: d, source: cashOf(d), form: { source: null, amount: "0.5", all: false } });
    expect(small.note?.text).toBe("The smallest repay is $1.");
    expect(small.ready).toBe(false);
  });

  it("All that covers what's owed says so, and the toast says all of it", () => {
    const d = data({ debt: 64, wallet: 500 });
    const v = planRepay({ data: d, source: cashOf(d), form: REPAY_FORM });
    expect(v.coversAll).toBe(true);
    expect(v.oweAfterUsd).toBe(0);
    expect(v.after).toBe("safe");
    expect(v.done).toBe(REPAY_COPY.doneAll);
    expect(repaySign(v, user, d.debtRaw)).toEqual({
      via: "cash",
      input: { user, all: true, coversAll: true, amount: 64, amountRaw: usd(64) + usd(64) / 2000n + 1n },
    });
  });
});

describe("Status after, per row", () => {
  const d = data({ debt: 500 }); // 700 / 500 = 1.4: Watch
  const s = repaySources(d, cfs);
  const row = (id: string) => s.find((x) => x.id === id)!;

  it("cash or a free stock lowers what's owed and keeps every share of backing", () => {
    expect(d.status).toBe("watch");
    // 700 / (500 − 50) = 1.56: Safe.
    expect(statusAfter(row("cash"), 50, d)).toBe("safe");
    expect(statusAfter(row("free:AAPLc"), 50, d)).toBe("safe");
    // 700 / (500 − 10) = 1.43: still Watch.
    expect(statusAfter(row("cash"), 10, d)).toBe("watch");
  });

  it("a backing stock also takes its backing out, so the same dollars leave it lower", () => {
    // Backing: (700 − (50 + 0.5) / 0.99 × 0.7) / 450 = 1.476: Watch, where cash reached Safe.
    expect(statusAfter(row("backing:NVDAc"), 50, d)).toBe("watch");
  });

  it("a row is capped at what it can repay; all of it reads Safe; nothing typed is the status now", () => {
    expect(statusAfter(row("free:NVDAc"), 400, d)).toBe(statusAfter(row("free:NVDAc"), row("free:NVDAc").estUsd, d));
    expect(statusAfter(row("backing:NVDAc"), 500, d)).toBe("safe");
    expect(statusAfter(row("cash"), 0, d)).toBe("watch");
  });
});

describe("sharesForRepay", () => {
  const maxShares = shares(0.5);
  const maxQuote = quoteAt(maxShares, 199);
  const maxFloorRaw = sellMinOut(maxQuote, aapl, 200);
  const base = { full: false, feeFromSale: false, maxSharesRaw: maxShares, maxQuote, maxFloorRaw };

  it("sells enough that the sale's floor brings the target, at the floor per share of all the shares", () => {
    const s = sharesForRepay({ ...base, targetRaw: usd(25) });
    // At least the target, with a hair over it (0.01% and 10 units) for rounding and a tick between quotes.
    expect(sellMinOut(quoteAt(s, 199), aapl, 200)).toBeGreaterThanOrEqual(usd(25) + usd(25) / 10_000n + 10n - 2n);
    expect(sellMinOut(quoteAt(s, 199), aapl, 200)).toBeLessThan(usd(25.004));
  });

  it("plus the fee buffer when the sale pays it, a margin on a full repay, at least a $1 sale, never more than it has", () => {
    const plain = sharesForRepay({ ...base, targetRaw: usd(25) });
    expect(sellMinOut(quoteAt(sharesForRepay({ ...base, targetRaw: usd(25), feeFromSale: true }), 199), aapl, 200)).toBeGreaterThanOrEqual(usd(25.5));
    expect(sharesForRepay({ ...base, targetRaw: usd(25), full: true })).toBeGreaterThan(plain);
    expect(quoteAt(sharesForRepay({ ...base, targetRaw: usd(0.1) }), 199).amountOut).toBeGreaterThanOrEqual(usd(1));
    expect(sharesForRepay({ ...base, targetRaw: usd(5_000) })).toBe(maxShares);
  });
});

describe("Pay with a stock held free: the plan", () => {
  const d = data();
  const apple = repaySources(d, cfs).find((x) => x.id === "free:AAPLc")!;
  const maxQ = quoteAt(apple.maxSharesRaw, 199);
  const plan = (form: RepayForm, q?: (s: bigint) => SellQuote, dd = d, src = apple) => {
    const sized = planRepay({ data: dd, source: src, form, maxQuote: ready(maxQ), now: tuesday });
    return planRepay({ data: dd, source: src, form, maxQuote: ready(maxQ), quote: q ? ready(q(sized.sharesRaw)) : undefined, now: tuesday });
  };

  it("All is what selling every free share is sure to bring", () => {
    const v = plan(REPAY_FORM, (s) => quoteAt(s, 199));
    expect(v.sharesRaw).toBe(apple.maxSharesRaw);
    expect(v.max.raw).toBe(minOut(maxQ.amountOut));
    expect(v.repayRaw).toBe(minOut(maxQ.amountOut));
    expect(v.fieldText).toBe("98.50");
    expect(v.sharesLine).toBe("Sells 0.5 AAPL");
    expect(v.ready).toBe(true);
  });

  it("$25 sells the shares whose floor brings $25 and repays exactly that floor, never more", () => {
    const v = plan({ source: apple.id, amount: "25", all: false }, (s) => quoteAt(s, 199));
    expect(v.sharesRaw).toBeLessThan(apple.maxSharesRaw);
    expect(v.repayRaw).toBe(sellMinOut(v.quote!, aapl, 200));
    expect(v.repayRaw).toBeGreaterThanOrEqual(usd(25));
    expect(v.repayRaw).toBeLessThan(usd(25.01));
    expect(v.oweAfterUsd).toBeCloseTo(300 - Number(v.repayRaw) / 1e6, 6);
    expect(v.after).toBe("safe");
    expect(v.fee).toBe(REPAY_COPY.feeFromCash);
    expect(v.sharesLine).toMatch(/^Sells 0\.12\d+ AAPL$/);
    expect(repaySmallPrint(v)).toMatch(/exactly 0\.12\d+ AAPL is approved for the Aerodrome router and sold for at least \$25\.00, then exactly \$25\.00 of it is approved and repaid/);
  });

  it("with no cash for the fee, the sale pays it: the repay is its floor less $0.50", () => {
    const poor = data({ wallet: 0.3 });
    const src = repaySources(poor, cfs).find((x) => x.id === "free:AAPLc")!;
    const v = plan({ source: src.id, amount: "25", all: false }, (s) => quoteAt(s, 199), poor, src);
    expect(v.fee).toBe(REPAY_COPY.feeFromSale);
    expect(v.repayRaw).toBe(sellMinOut(v.quote!, aapl, 200) - fee);
    expect(v.repayRaw).toBeGreaterThanOrEqual(usd(25));
  });

  it("covering what's owed repays it in full, and the toast says so", () => {
    const small = data({ debt: 20 });
    const src = repaySources(small, cfs).find((x) => x.id === "free:AAPLc")!;
    const v = plan(REPAY_FORM, (s) => quoteAt(s, 199), small, src);
    expect(v.max.coversAll).toBe(true);
    expect(v.fieldText).toBe("20.00");
    expect(v.sharesRaw).toBeLessThan(src.maxSharesRaw);
    expect(v.repayRaw).toBe(usd(20) + usd(20) / 2000n + 1n);
    expect(v.coversAll).toBe(true);
    expect(v.oweAfterUsd).toBe(0);
    expect(v.done).toBe(REPAY_COPY.doneAll);
  });

  it("All quoted under $1 (a row listed on its estimate) says the smallest repay and can't go ahead", () => {
    const one = data({ holdings: [holding("AAPLc", "Apple", 200, 0.0052, 0)] });
    const src = repaySources(one, cfs).find((x) => x.id === "free:AAPLc")!;
    const v = planRepay({ data: one, source: src, form: REPAY_FORM, maxQuote: ready(quoteAt(src.maxSharesRaw, 190)), now: tuesday });
    expect(v.max.usd).toBeLessThan(1);
    expect(v.note?.text).toBe("The smallest repay is $1.");
    expect(v.ready).toBe(false);
  });

  it("waits for its quotes, says when there's no market, and warns on a thin one", () => {
    const quoting = planRepay({ data: d, source: apple, form: REPAY_FORM, now: tuesday });
    expect(quoting.ready).toBe(false);
    expect(quoting.quoting).toBe(true);
    expect(quoting.sharesLine).toBe(REPAY_COPY.sellsQuoting);
    const none = planRepay({ data: d, source: apple, form: REPAY_FORM, maxQuote: { data: null, isFetching: false, isSuccess: true }, now: tuesday });
    expect(none.note?.text).toBe("There’s no market for Apple right now.");
    const thin = plan({ source: apple.id, amount: "25", all: false }, (s) => quoteAt(s, 194));
    expect(thin.note?.text).toMatch(/^You’d get 3\.0% under the stock’s price/);
    expect(thin.ready).toBe(true);
  });

  it("signs a free repay with the screen's quote and plan", () => {
    const v = plan({ source: apple.id, amount: "25", all: false }, (s) => quoteAt(s, 199));
    const sign = repaySign(v, user, d.debtRaw)!;
    expect(sign.via).toBe("free");
    expect(sign.input).toMatchObject({ user, stock: aapl, quote: v.quote, oraclePriceUsd: 200, debtRaw: d.debtRaw, feeFromSale: false });
  });
});

describe("Pay with a stock that backs the credit: the existing repay by selling", () => {
  const d = data();
  const nv = repaySources(d, cfs).find((x) => x.id === "backing:NVDAc")!;
  const maxQ = quoteAt(nv.maxSharesRaw, 249);
  const plan = (form: RepayForm, q: (s: bigint) => SellQuote) => {
    const sized = planRepay({ data: d, source: nv, form, maxQuote: ready(maxQ), now: tuesday });
    return planRepay({ data: d, source: nv, form, maxQuote: ready(maxQ), quote: ready(q(sized.sharesRaw)), now: tuesday });
  };

  it("$50 takes the shares out, sells them and repays the floor less the fee, which the sale pays", () => {
    const v = plan({ source: nv.id, amount: "50", all: false }, (s) => quoteAt(s, 249));
    expect(v.sellPlan?.from).toBe("repay");
    expect(v.repayRaw).toBe(saleRepayRaw(sellMinOut(v.quote!, nvda, 250), d.debtRaw));
    expect(v.repayRaw).toBeGreaterThanOrEqual(usd(50));
    expect(v.fee).toBe(REPAY_COPY.feeFromSale);
    expect(v.after).toBe("safe");
    expect(v.ready).toBe(true);
    expect(repaySmallPrint(v)).toMatch(/^In one go: exactly 0\.2\d+ NVDA comes out of backing, is approved for the Aerodrome router and sold for at least \$50\.\d\d, then exactly \$50\.\d\d of it is approved and repaid\. What the sale brings above that stays in your cash, \$0\.50 of it for the network fee\./);
    const sign = repaySign(v, user, d.debtRaw)!;
    expect(sign.via).toBe("backing");
    expect(sign.input).toMatchObject({ user, stock: nvda, quote: v.quote, oraclePriceUsd: 250, debtRaw: d.debtRaw });
  });

  it("All repays everything owed with the margin, and what the sale brings above it stays as cash", () => {
    const v = plan(REPAY_FORM, (s) => quoteAt(s, 249));
    expect(v.max.coversAll).toBe(true);
    expect(v.coversAll).toBe(true);
    expect(v.sharesRaw).toBeLessThan(nv.maxSharesRaw);
    expect(v.oweAfterUsd).toBe(0);
  });

  it("the sale's stops read in the sheet's words, with no protocol in them", () => {
    const paused = { ...nv, holding: { ...nv.holding!, paused: true } };
    const sized = planRepay({ data: d, source: paused, form: { source: nv.id, amount: "50", all: false }, maxQuote: ready(maxQ), now: tuesday });
    const v = planRepay({ data: d, source: paused, form: { source: nv.id, amount: "50", all: false }, maxQuote: ready(maxQ), quote: ready(quoteAt(sized.sharesRaw, 249)), now: tuesday });
    expect(v.note?.text).toBe("NVIDIA can’t come out of backing right now. Try again later.");
    for (const text of Object.values(REPAY_COPY)) if (typeof text === "string") expect(text).not.toMatch(/Aave|spoke|collateral|borrow|loan|lock/i);
  });
});

describe("buildFreeRepayCalls: sell the free shares, then repay exactly what the sale is sure to bring", () => {
  const q: SellQuote = { venue: "aerodrome", pool: 10, amountIn: shares(0.4), amountOut: usd(99.5) };
  const build = (p: { debt?: number; feeFromSale?: boolean; quote?: SellQuote } = {}) =>
    buildFreeRepayCalls({ user, stock: nvda, quote: p.quote ?? q, oraclePriceUsd: 250, debtRaw: usd(p.debt ?? 300), feeFromSale: p.feeFromSale ?? false, nowSec: 1_000 });

  it("approve the shares → swap to USDC for the user → approve exactly the repay → repay it for the user", () => {
    const calls = build();
    expect(steps(calls)).toEqual(["approve", "swap", "approve", "repay"]);
    const floor = sellMinOut(q, nvda, 250);
    expect(swapOf(calls[1])!.params).toMatchObject({ tokenIn: nvda.address, tokenOut: USDC.address, recipient: user, amountIn: shares(0.4), amountOutMinimum: floor });
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([AAVE.SPOKE, floor]);
    expect(calls[2].to).toBe(USDC.address);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[3].data }).args).toEqual([BigInt(USDC.reserveId), floor, user]);
    // Nothing comes out of backing.
    expect(calls.some((c) => c.to === AAVE.SPOKE && fn(c.data) === "withdraw")).toBe(false);
  });

  it("the sale pays the fee when the cash can't: the repay is the floor less the buffer", () => {
    expect(repayArg(build({ feeFromSale: true }))).toBe(sellMinOut(q, nvda, 250) - fee);
  });

  it("more than is owed: a full repay, then the allowance goes back to 0", () => {
    const calls = build({ debt: 20 });
    expect(steps(calls)).toEqual(["approve", "swap", "approve", "repay", "approve"]);
    expect(repayArg(calls)).toBe(usd(20) + usd(20) / 2000n + 1n);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[4].data }).args).toEqual([AAVE.SPOKE, 0n]);
  });

  it("passes the allowlist for the user only", () => {
    const calls = build();
    expect(assertAllowed(user, calls)).toBe(calls);
    expect(() => assertAllowed(attacker, calls)).toThrow(/unexpected arguments/);
  });

  it("never repays more than the sale's floor, by construction, over any quote, debt and fee", () => {
    for (let i = 0; i < 200; i++) {
      const amountIn = BigInt(1 + Math.floor(Math.random() * 50_000_000));
      const quote: SellQuote = { venue: i % 2 ? "aerodrome" : "uniswap", pool: i % 2 ? 10 : 3000, amountIn, amountOut: BigInt(Math.floor(Number(amountIn) * 2.5 * (0.9 + Math.random() * 0.2))) };
      const debt = 1 + Math.random() * 500;
      const feeFromSale = i % 3 === 0;
      const floor = sellMinOut(quote, nvda, 250);
      if (freeRepayRaw(floor, usd(debt), feeFromSale) <= 0n) {
        expect(() => build({ quote, debt, feeFromSale })).toThrow();
        continue;
      }
      const calls = build({ quote, debt, feeFromSale });
      expect(repayArg(calls)).toBeLessThanOrEqual(floor - (feeFromSale ? fee : 0n));
    }
  });

  it("refuses a batch that repays more than the sale's floor, though every call on its own is allowed", () => {
    const calls = build();
    const floor = sellMinOut(q, nvda, 250);
    const tampered = calls.map((c) =>
      c.to === AAVE.SPOKE ? { ...c, data: encodeFunctionData({ abi: spokeAbi, functionName: "repay", args: [BigInt(USDC.reserveId), floor + 1n, user] }) } : c,
    );
    tampered[2] = { ...tampered[2], data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, floor + 1n] }) };
    expect(assertAllowed(user, tampered)).toBe(tampered); // the allowlist alone can't see the sale's floor…
    expect(() => assertSaleCoversRepay(user, tampered, false)).toThrow(/more than the sale is sure to bring/); // …this can
    // With the fee from the sale, the floor itself is already too much.
    expect(() => assertSaleCoversRepay(user, calls, true)).toThrow(/more than the sale is sure to bring/);
  });

  it("refuses an approval that isn't exactly the repay, a repay before the sale, and a sale paid to someone else", () => {
    const calls = build();
    const loose = [...calls];
    loose[2] = { ...loose[2], data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, usd(1_000)] }) };
    expect(() => assertSaleCoversRepay(user, loose, false)).toThrow(/not exact/);
    expect(() => assertSaleCoversRepay(user, [calls[2], calls[3], calls[0], calls[1]], false)).toThrow(/after a sale/);
    expect(() => assertSaleCoversRepay(attacker, calls, false)).toThrow(/after a sale/);
    expect(() => assertSaleCoversRepay(user, calls.slice(0, 2), false)).toThrow(/one sale and one repay/);
  });

  it("refuses when nothing is owed, and when the sale can't pay for any repay", () => {
    expect(() => build({ debt: 0 })).toThrow(/Nothing owed/);
    expect(() => build({ feeFromSale: true, quote: { ...q, amountIn: shares(0.001), amountOut: usd(0.25) } })).toThrow(/positive/);
  });
});

describe("A free repay's key and activity", () => {
  const sellPlan = { block: undefined, sharesRaw: shares(0.4), usd: 99.5, minOutRaw: minOut(usd(99.5)) } as unknown as FreeRepayInput["plan"];
  const input: FreeRepayInput = {
    user,
    stock: nvda,
    quote: { venue: "aerodrome", pool: 10, amountIn: shares(0.4), amountOut: usd(99.5) },
    plan: sellPlan,
    oraclePriceUsd: 250,
    debtRaw: usd(300),
    feeFromSale: false,
  };
  const noBatch = vi.fn(async () => []);
  const key = (p: Partial<FreeRepayInput> = {}) => freeRepayPlan({ ...input, ...p }, noBatch).key;

  it("changes with the quote, who pays the fee and whether it covers what's owed, not with interest", () => {
    expect(key({ quote: { ...input.quote, amountOut: usd(99.6) } })).not.toBe(key());
    expect(key({ feeFromSale: true })).not.toBe(key());
    expect(key({ stock: aapl })).not.toBe(key());
    expect(key({ debtRaw: usd(300.01) })).toBe(key());
    expect(key({ debtRaw: usd(20) })).not.toBe(key());
    expect(key({ debtRaw: usd(20) })).toBe(key({ debtRaw: usd(20.01) }));
  });

  it("shows the sale and the repay while it confirms", () => {
    expect(freeRepayPlan(input, noBatch).activity).toEqual([
      { kind: "sell", symbol: "NVDAc", amount: 0.4, receivedUsd: 99.5 },
      { kind: "repay", symbol: "USDC", amount: Number(minOut(usd(99.5))) / 1e6 },
    ]);
  });
});

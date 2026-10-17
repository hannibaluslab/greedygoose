import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi, isAddressEqual, parseUnits, type Hex } from "viem";

// assertAllowed, spied but unchanged: buildTradeCalls must run every call of the batch through it.
vi.mock("@/lib/allowlist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/allowlist")>();
  return { ...actual, assertAllowed: vi.fn(actual.assertAllowed) };
});

import { TxStop } from "@/hooks/useTx";
import { swapBatch, type SwapReads } from "@/hooks/useTrade";
import { AAVE } from "@/lib/aave/addresses";
import { assertAllowed, swapOf } from "@/lib/allowlist";
import { feeBufferRaw, payFromCash, type Cash } from "@/lib/cash";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { aeroRouterAbi } from "@/lib/swap/abis";
import { QUOTE_MOVED, minOut, type BuyQuote } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { CASH } from "@/config/risk";
import { formatUsd } from "@/lib/formatting";
import {
  TRADE_COPY,
  buildTradeCalls,
  clampAmount,
  defaultLegs,
  emptyLine,
  feeFromSale,
  fromOptions,
  maxUsdOf,
  planTrade,
  routeOf,
  sharesForUsdRaw,
  swapBuyInRaw,
  swapMinUsd,
  swapSmallPrint,
  toOptions,
  tradeActivity,
  tradeForm,
  type QuoteState,
  type TradeAction,
  type TradeData,
  type TradeForm,
  type TradeHolding,
} from "@/lib/trade";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
/** The network-fee buffer in dollars; wallet USDC under it (`short`), the rest of the buffer then comes from savings. */
const B = CASH.feeBufferUsd;
const shortRaw = (feeBufferRaw * 2n) / 5n;
const stock = (symbol: string) => EQUITIES.find((e) => e.symbol === symbol)!;
const nvda = stock("NVDAc");
const aapl = stock("AAPLc");

/** Aave's prices in the fixtures. */
const PRICE: Record<string, number> = {
  AAPLc: 250,
  AMZNc: 225,
  GOOGLc: 240,
  METAc: 700,
  MSFTc: 500,
  NVDAc: 200,
  TSLAc: 400,
};

/** A holding as usePosition reads it, from dollars free and backing at Aave's price. */
function holding(symbol: string, freeUsd = 0, lockedUsd = 0): TradeHolding {
  const e = stock(symbol);
  const p = PRICE[symbol];
  const raw = (v: number) => BigInt(Math.round((v / p) * 1e8));
  const freeRaw = raw(freeUsd);
  const lockedRaw = raw(lockedUsd);
  return {
    symbol,
    name: e.name,
    priceUsd: p,
    priceRaw: parseUnits(p.toFixed(8), 8),
    freeRaw,
    lockedRaw,
    freeUsd: (Number(freeRaw) / 1e8) * p,
    lockedUsd: (Number(lockedRaw) / 1e8) * p,
    freeShares: Number(freeRaw) / 1e8,
    lockedShares: Number(lockedRaw) / 1e8,
    multiplier: 10n ** 18n,
    paused: false,
  };
}

function account(cash: Cash, held: Record<string, [number, number]>): TradeData {
  const holdings = EQUITIES.map((e) => holding(e.symbol, ...(held[e.symbol] ?? [0, 0])));
  const debt = holdings.some((h) => h.lockedRaw > 0n) ? 2_000 : 0;
  return {
    holdings,
    cash,
    cashUsd: Number(cash.walletRaw + cash.savingsRaw) / 1e6,
    collateralUsd: holdings.reduce((a, h) => a + h.lockedUsd, 0),
    avgCf: 0.7,
    debtUsd: debt,
    debtRaw: usd(debt),
    healthFactor: debt ? 2.1 : null,
  };
}

/** Shaped like the dev preview's backer: cash, $1.80 of free Amazon beside backing, four stocks all backing, Tesla dust, no Apple. */
const backer = account(
  { walletRaw: usd(20), savingsRaw: usd(1_919.18), saveOn: false },
  {
    AMZNc: [1.8, 1_721.43],
    GOOGLc: [0, 900],
    METAc: [0, 1_400],
    MSFTc: [0, 800],
    NVDAc: [0, 2_500],
    TSLAc: [0.09, 0],
  },
);
/** Shaped like the preview's newcomer: cash and all seven stocks free. */
const newcomer = account(
  { walletRaw: usd(40), savingsRaw: 0n, saveOn: false },
  { AAPLc: [30, 0], AMZNc: [12, 0], GOOGLc: [8, 0], METAc: [20, 0], MSFTc: [9, 0], NVDAc: [50, 0], TSLAc: [6, 0] },
);
const empty = account({ walletRaw: 0n, savingsRaw: 0n, saveOn: false }, {});
/** What MAX takes from the backer's cash: all of it less the fee buffer, to the cent. */
const BACKER_MAX = Math.floor((1_939.18 - B) * 100 + 1e-6) / 100;

const ready = <Q>(data: Q): QuoteState<Q> => ({ data, isFetching: false, isSuccess: true });
const loading: QuoteState<never> = { data: undefined, isFetching: true, isSuccess: false };
const noPool: QuoteState<never> = { data: null, isFetching: false, isSuccess: true };
/** A weekday in New York, markets open (Wednesday 2026-10-14, 15:00 UTC); and a Saturday. */
const OPEN = new Date("2026-10-14T15:00:00Z");
const SATURDAY = new Date("2026-10-17T15:00:00Z");

/** A buy of `stock` for `amountIn` USDC, paying `premium` over Aave's price. */
const buyQuoteFor = (
  symbol: string,
  amountIn: bigint,
  premium = 0.003,
  venue: BuyQuote["venue"] = "aerodrome",
): BuyQuote => ({
  venue,
  pool: venue === "aerodrome" ? 10 : 3000,
  amountIn,
  amountOut: BigInt(Math.floor((Number(amountIn) / 1e6 / (PRICE[symbol] * (1 + premium))) * 1e8)),
});
/** A sale of `sharesRaw` of `symbol`, paying `discount` under Aave's price. */
const sellQuoteFor = (
  symbol: string,
  sharesRaw: bigint,
  discount = 0.002,
  venue: SellQuote["venue"] = "aerodrome",
): SellQuote => ({
  venue,
  pool: venue === "aerodrome" ? 10 : 3000,
  amountIn: sharesRaw,
  amountOut: BigInt(Math.floor((Number(sharesRaw) / 1e8) * PRICE[symbol] * (1 - discount) * 1e6)),
});

describe("routes", () => {
  it("cash → stock buys, stock → cash sells, stock → stock swaps; the same asset or an unknown one is no trade", () => {
    expect(routeOf("cash", "NVDAc")).toBe("buy");
    expect(routeOf("NVDAc", "cash")).toBe("sell");
    expect(routeOf("NVDAc", "AAPLc")).toBe("swap");
    expect(routeOf("NVDAc", "NVDAc")).toBeNull();
    expect(routeOf("cash", "cash")).toBeNull();
    expect(routeOf("cash", "USDC")).toBeNull();
    expect(routeOf("XYZc", "cash")).toBeNull();
  });
});

describe("dollars to shares at Aave's price", () => {
  it("is exact in raw units, rounded down", () => {
    // $100 at $250 = 0.4 shares
    expect(sharesForUsdRaw(usd(100), parseUnits("250", 8), 8)).toBe(40_000_000n);
    // $1 at $3 = 0.33333333… → 33_333_333
    expect(sharesForUsdRaw(usd(1), parseUnits("3", 8), 8)).toBe(33_333_333n);
    expect(sharesForUsdRaw(usd(1.8), parseUnits("225.12345678", 8), 8)).toBe(
      (1_800_000n * 10n ** 10n) / 22_512_345_678n,
    );
  });
  it("is 0 with no price or no dollars", () => {
    expect(sharesForUsdRaw(usd(100), 0n, 8)).toBe(0n);
    expect(sharesForUsdRaw(0n, parseUnits("250", 8), 8)).toBe(0n);
  });
});

describe("what a stock → stock buy spends", () => {
  const floor = usd(2.968628);
  it("is exactly the sale's floor when the cash can pay the network fee", () => {
    const cash = { walletRaw: feeBufferRaw, savingsRaw: 0n, saveOn: false };
    expect(feeFromSale(cash)).toBe(false);
    expect(swapBuyInRaw(floor, cash)).toBe(floor);
    expect(swapBuyInRaw(floor, { walletRaw: 0n, savingsRaw: usd(10), saveOn: true })).toBe(floor);
  });
  it("leaves the fee buffer to the sale when the cash is under it, and is never negative", () => {
    const cash = { walletRaw: feeBufferRaw / 2n, savingsRaw: feeBufferRaw / 2n - 1n, saveOn: false };
    expect(feeFromSale(cash)).toBe(true);
    expect(swapBuyInRaw(floor, cash)).toBe(floor - feeBufferRaw);
    expect(swapBuyInRaw(feeBufferRaw - 1n, cash)).toBe(0n);
  });
  it("the smallest trade reaches a $1 buy from the sale's floor, rounded up to 10 cents, never under $1", () => {
    expect(swapMinUsd(1, false)).toBe(1.1); // 1 / 0.99 = 1.0101 → $1.10
    expect(swapMinUsd(0.998, false)).toBe(1.1);
    // $1 and the fee buffer, over the floor's 0.99, up to 10 cents ($1.10 / 0.99 = 1.111 → $1.20 at a $0.10 buffer).
    expect(swapMinUsd(1, true)).toBe(Math.ceil(((1 + B) / 0.99) * 10 - 1e-9) / 10);
    expect(swapMinUsd(0.9, false)).toBe(1.2);
  });
});

describe("buildTradeCalls (stock → stock in one batch)", () => {
  const sellQuote = sellQuoteFor("NVDAc", 1_367_030n, 0.002, "aerodrome");
  const floor = sellMinOut(sellQuote, nvda, PRICE.NVDAc);
  const buyQuote = buyQuoteFor("AAPLc", floor, 0.003, "uniswap");
  const build = (over: Partial<Parameters<typeof buildTradeCalls>[0]> = {}) =>
    buildTradeCalls({
      user,
      from: nvda,
      to: aapl,
      sellQuote,
      buyQuote,
      oraclePriceUsd: PRICE.NVDAc,
      nowSec: 1_000,
      ...over,
    });

  it("approves exactly the shares, sells them to the user for at least the floor, approves exactly the buy-in and buys to the user", () => {
    const calls = build();
    expect(calls).toHaveLength(4);
    const [approveA, sell, approveUsdc, buy] = calls;

    expect(approveA.to).toBe(nvda.address);
    expect(decodeFunctionData({ abi: erc20Abi, data: approveA.data }).args).toEqual([AERODROME.ROUTER, 1_367_030n]);

    expect(sell.to).toBe(AERODROME.ROUTER);
    const s = decodeFunctionData({ abi: aeroRouterAbi, data: sell.data }).args[0];
    expect(s).toMatchObject({
      tokenIn: nvda.address,
      tokenOut: USDC.address,
      recipient: user,
      amountIn: 1_367_030n,
      amountOutMinimum: floor,
      deadline: 1_600n,
    });

    expect(approveUsdc.to).toBe(USDC.address);
    expect(decodeFunctionData({ abi: erc20Abi, data: approveUsdc.data }).args).toEqual([UNISWAP.SWAP_ROUTER_02, floor]);

    expect(buy.to).toBe(UNISWAP.SWAP_ROUTER_02);
    const b = swapOf(buy)!.params as unknown as {
      tokenIn: Address;
      tokenOut: Address;
      recipient: Address;
      amountIn: bigint;
      amountOutMinimum: bigint;
    };
    expect(b).toMatchObject({
      tokenIn: USDC.address,
      tokenOut: aapl.address,
      recipient: user,
      amountIn: floor,
      amountOutMinimum: minOut(buyQuote.amountOut),
    });
  });

  it("the buy spends no more than the sale is sure to bring, and the sale's floor is the larger of the quote less 1% and Aave's less 10%", () => {
    expect(floor).toBe(minOut(sellQuote.amountOut));
    const thin = sellQuoteFor("NVDAc", 1_367_030n, 0.095); // the pool pays 9.5% under Aave's price
    expect(sellMinOut(thin, nvda, PRICE.NVDAc)).toBeGreaterThan(minOut(thin.amountOut));
    expect(
      build()
        .filter((c) => isAddressEqual(c.to, USDC.address))
        .map((c) => decodeFunctionData({ abi: erc20Abi, data: c.data }).args[1]),
    ).toEqual([floor]);
  });

  it("runs the whole batch through the allowlist, pinned to the user", () => {
    vi.mocked(assertAllowed).mockClear();
    const calls = build();
    expect(assertAllowed).toHaveBeenCalledWith(user, calls);
    // Pinned to someone else, every swap pays the wrong account and is refused.
    expect(() => assertAllowed("0x0000000000000000000000000000000000000001", calls)).toThrow(/unexpected arguments/);
  });

  it("never touches the Aave spoke: free shares only, so credit and backing can't move", () => {
    expect(build().some((c) => isAddressEqual(c.to, AAVE.SPOKE))).toBe(false);
  });

  it("refuses a buy one unit over the floor, the same stock both sides, or anything but a stock", () => {
    expect(() => build({ buyQuote: { ...buyQuote, amountIn: floor + 1n } })).toThrow(
      /more than the sale is sure to bring/,
    );
    expect(() => build({ to: nvda })).toThrow(/Not a supported trade/);
    expect(() => build({ to: USDC })).toThrow(/Not a supported trade/);
    expect(() => build({ from: USDC })).toThrow(/Not a supported trade/);
  });

  it("a tampered recipient or router fails the allowlist", () => {
    const calls = build();
    const stranger: Address = "0x1111111111111111111111111111111111111111";
    const s = decodeFunctionData({ abi: aeroRouterAbi, data: calls[1].data }).args[0];
    const tampered: Hex = encodeFunctionData({
      abi: aeroRouterAbi,
      functionName: "exactInputSingle",
      args: [{ ...s, recipient: stranger }],
    });
    expect(() => assertAllowed(user, [calls[0], { ...calls[1], data: tampered }])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [{ ...calls[1], to: stranger }])).toThrow(/unexpected target/);
  });

  it("when the cash pays the fee and the wallet holds less than the buffer, a savings withdrawal to the user goes first", () => {
    const cash: Cash = { walletRaw: shortRaw, savingsRaw: usd(50), saveOn: false };
    expect(feeFromSale(cash)).toBe(false);
    const batch = payFromCash(user, 0n, cash, build());
    expect(batch).toHaveLength(5);
    expect(batch[0].to).toBe(GUARDIAN.AAVE_V3_POOL);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: batch[0].data }).args).toEqual([
      USDC.address,
      feeBufferRaw - shortRaw,
      user,
    ]);
    // With the whole buffer in the wallet there's nothing to withdraw.
    expect(payFromCash(user, 0n, { ...cash, walletRaw: feeBufferRaw }, build())).toHaveLength(4);
  });
});

describe("the pickers", () => {
  it("From: cash, then the free stocks by free value, then the ones that can't trade, with why", () => {
    const rows = fromOptions(backer);
    expect(rows.map((r) => [r.asset, r.disabled, r.sub])).toEqual([
      ["cash", false, undefined],
      ["AMZNc", false, "$1,721.43 of it backs your credit"],
      ["TSLAc", true, "Under $1 free, too small to trade"],
      ["NVDAc", true, "All of it backs your credit"],
      ["METAc", true, "All of it backs your credit"],
      ["GOOGLc", true, "All of it backs your credit"],
      ["MSFTc", true, "All of it backs your credit"],
    ]);
    expect(rows[1]).toMatchObject({ right: "$1.80", rightSub: "free" });
    expect(rows.find((r) => r.asset === "AAPLc")).toBeUndefined(); // not held, not listed
  });

  it("From: the Cash row says what MAX takes, the cash less the network-fee buffer, as the stock rows do", () => {
    expect(backer.cashUsd).toBe(1_939.18);
    expect(fromOptions(backer)[0]).toMatchObject({ asset: "cash", right: formatUsd(BACKER_MAX), rightSub: "to trade" });
    expect(fromOptions(backer)[0].right).toBe(
      `$${maxUsdOf("cash", backer).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
    // Under the fee buffer it can't be picked: no "to trade", and MAX would take nothing.
    const poor = fromOptions({
      ...newcomer,
      cash: { walletRaw: shortRaw, savingsRaw: 0n, saveOn: false },
      cashUsd: Number(shortRaw) / 1e6,
    });
    expect(poor[0]).toMatchObject({ right: "$0.00", rightSub: undefined, disabled: true });
  });

  it("From: a newcomer's free stocks show their shares; cash without $1 and the fee buffer can't be picked", () => {
    const rows = fromOptions(newcomer);
    expect(rows.map((r) => r.asset)).toEqual(["cash", "NVDAc", "AAPLc", "METAc", "AMZNc", "MSFTc", "GOOGLc", "TSLAc"]);
    expect(rows[1].sub).toBe("0.25 shares");
    const poor = fromOptions({
      ...newcomer,
      cash: { walletRaw: usd(1 + B - 0.01), savingsRaw: 0n, saveOn: false },
      cashUsd: 1 + B - 0.01,
    });
    expect(poor[0]).toMatchObject({ asset: "cash", disabled: true, sub: "Not enough to trade", why: "no-cash" });
  });

  it("To: cash, the stocks held by value, then the rest A to Z, each with Aave's price a share", () => {
    const rows = toOptions(backer);
    expect(rows.map((r) => r.asset)).toEqual(["cash", "NVDAc", "AMZNc", "METAc", "GOOGLc", "MSFTc", "TSLAc", "AAPLc"]);
    expect(rows.find((r) => r.asset === "AAPLc")).toMatchObject({
      sub: "$250.00 a share",
      right: undefined,
      ownedUsd: 0,
    });
    expect(rows.find((r) => r.asset === "AMZNc")!.right).toBe("$1,723.23");
    expect(rows.every((r) => !r.disabled)).toBe(true);
  });

  it("opens on cash into the biggest holding, a stock into cash, or nothing at all", () => {
    expect(defaultLegs(backer)).toEqual({ from: "cash", to: "NVDAc" });
    expect(defaultLegs(newcomer)).toEqual({ from: "cash", to: "NVDAc" });
    const noCash = { ...newcomer, cash: { walletRaw: 0n, savingsRaw: 0n, saveOn: false }, cashUsd: 0 };
    expect(defaultLegs(noCash)).toEqual({ from: "NVDAc", to: "cash" });
    expect(defaultLegs({ ...empty, cash: { walletRaw: usd(10), savingsRaw: 0n, saveOn: false }, cashUsd: 10 })).toEqual(
      { from: "cash", to: "GOOGLc" },
    );
    expect(defaultLegs(empty)).toBeNull();
    expect(
      defaultLegs({
        ...backer,
        cash: empty.cash,
        cashUsd: 0,
        holdings: backer.holdings.map((h) => ({ ...h, freeRaw: 0n, freeUsd: 0 })),
      }),
    ).toBeNull();
  });

  it("a seed wins when it can trade", () => {
    expect(defaultLegs(newcomer, { from: "TSLAc", to: "AAPLc" })).toEqual({ from: "TSLAc", to: "AAPLc" });
    expect(defaultLegs(backer, { from: "NVDAc" })).toEqual({ from: "cash", to: "NVDAc" }); // all backs: it can't be From
    expect(defaultLegs(newcomer, { to: "TSLAc" })).toEqual({ from: "cash", to: "TSLAc" });
    expect(defaultLegs(newcomer, { to: "cash" })).toEqual({ from: "cash", to: "NVDAc" });
  });

  it("the empty state says why", () => {
    expect(emptyLine(empty)).toBe("Top up your cash to buy stocks.");
    expect(emptyLine(backer)).toBe("What you hold backs your credit. Top up your cash to trade.");
  });
});

describe("the amount", () => {
  it("cash takes up to the cash less the fee buffer, to the cent", () => {
    expect(maxUsdOf("cash", backer)).toBe(BACKER_MAX);
    expect(clampAmount("cash", backer, "5000")).toEqual({ amount: BACKER_MAX.toFixed(2), all: false });
    expect(clampAmount("cash", backer, "100")).toEqual({ amount: "100", all: false });
  });

  it("a stock takes its free shares: over it snaps to all of them", () => {
    expect(maxUsdOf("AMZNc", backer)).toBe(1.8);
    expect(clampAmount("AMZNc", backer, "2")).toEqual({ amount: "1.8", all: true });
    const a = planTrade({ from: "AMZNc", to: "cash", amount: "1.8", all: true, data: backer, now: OPEN });
    expect(a.sharesRaw).toBe(backer.holdings.find((h) => h.symbol === "AMZNc")!.freeRaw);
  });

  it("a stock's amount at exactly its free value sells every free share; cash's never does", () => {
    expect(clampAmount("AMZNc", backer, "1.8")).toEqual({ amount: "1.8", all: true });
    expect(clampAmount("AMZNc", backer, "1.80")).toEqual({ amount: "1.80", all: true });
    expect(clampAmount("AMZNc", backer, "1.79")).toEqual({ amount: "1.79", all: false });
    expect(clampAmount("cash", backer, BACKER_MAX.toFixed(2))).toEqual({ amount: BACKER_MAX.toFixed(2), all: false });
  });

  it("all of it only while the dollars still say all of it: shares that arrive after MAX aren't sold unseen", () => {
    const more = {
      ...backer,
      holdings: backer.holdings.map((h) => (h.symbol === "AMZNc" ? holding("AMZNc", 50, 1_721.43) : h)),
    };
    const v = planTrade({ from: "AMZNc", to: "cash", amount: "1.8", all: true, data: more, now: OPEN });
    expect(v.sharesRaw).toBe(sharesForUsdRaw(usd(1.8), parseUnits("225", 8), 8));
    expect(v.sharesRaw).toBeLessThan(more.holdings.find((h) => h.symbol === "AMZNc")!.freeRaw);
  });

  it("nothing to take leaves the amount as typed (the status line says why)", () => {
    expect(maxUsdOf("NVDAc", backer)).toBe(0);
    expect(clampAmount("NVDAc", backer, "40")).toEqual({ amount: "40", all: false });
  });

  it("typed dollars on a stock are shares at Aave's price, rounded down", () => {
    const v = planTrade({ from: "NVDAc", to: "cash", amount: "50", all: false, data: newcomer, now: OPEN });
    expect(v.sharesRaw).toBe(25_000_000n);
  });
});

describe("the sheet's legs and amount (tradeForm)", () => {
  /** Shaped like the live backer: Amazon's free value has dust under a cent ($1.7998), so MAX's dollars read $1.79. */
  const dusty = {
    ...backer,
    holdings: backer.holdings.map((h) => (h.symbol === "AMZNc" ? holding("AMZNc", 1.7998, 1_721.43) : h)),
  };
  const amzn = dusty.holdings.find((h) => h.symbol === "AMZNc")!;
  const run = (state: TradeForm, ...actions: TradeAction[]) => actions.reduce((f, a) => tradeForm(f, a, dusty), state);
  const start = (from: string, to: string, amount = ""): TradeForm => ({ legs: { from, to }, amount, all: false });
  const sharesOf = (f: TradeForm) =>
    planTrade({ from: f.legs!.from, to: f.legs!.to, amount: f.amount, all: f.all, data: dusty, now: OPEN }).sharesRaw;

  it("MAX on a stock takes its free value to the cent and sells every free share", () => {
    expect(maxUsdOf("AMZNc", dusty)).toBe(1.79);
    const f = run(start("AMZNc", "cash"), { type: "max" });
    expect(f).toEqual({ legs: { from: "AMZNc", to: "cash" }, amount: "1.79", all: true });
    expect(sharesOf(f)).toBe(amzn.freeRaw);
  });

  it("MAX keeps selling every free share when To changes, and back (the review's AMZN → NVIDIA → Cash)", () => {
    const f = run(
      start("AMZNc", "cash"),
      { type: "max" },
      { type: "pick", which: "to", asset: "NVDAc" },
      { type: "pick", which: "to", asset: "cash" },
    );
    expect(f).toEqual({ legs: { from: "AMZNc", to: "cash" }, amount: "1.79", all: true });
    expect(sharesOf(f)).toBe(amzn.freeRaw);
    const swap = run(start("AMZNc", "cash"), { type: "max" }, { type: "pick", which: "to", asset: "AAPLc" });
    expect(swap.all).toBe(true);
    expect(sharesOf(swap)).toBe(amzn.freeRaw);
  });

  it("a flip away and back still sells every free share: the dollars are exactly the free value", () => {
    const away = run(start("AMZNc", "NVDAc"), { type: "max" }, { type: "flip" });
    expect(away).toEqual({ legs: { from: "NVDAc", to: "AMZNc" }, amount: "1.79", all: false }); // NVIDIA has nothing free
    const back = run(away, { type: "flip" });
    expect(back).toEqual({ legs: { from: "AMZNc", to: "NVDAc" }, amount: "1.79", all: true });
    expect(sharesOf(back)).toBe(amzn.freeRaw);
  });

  it("a flip keeps the dollars, clamped to what the new From takes", () => {
    const f = run(start("cash", "AMZNc", "500"), { type: "flip" });
    expect(f).toEqual({ legs: { from: "AMZNc", to: "cash" }, amount: "1.79", all: true });
    expect(run(f, { type: "flip" })).toEqual({ legs: { from: "cash", to: "AMZNc" }, amount: "1.79", all: false });
  });

  it("typing under the most drops all of it; typing over snaps to it", () => {
    const f = run(start("AMZNc", "cash"), { type: "max" }, { type: "amount", value: "1.7" });
    expect(f).toEqual({ legs: { from: "AMZNc", to: "cash" }, amount: "1.7", all: false });
    expect(sharesOf(f)).toBe(sharesForUsdRaw(usd(1.7), amzn.priceRaw, 8));
    expect(run(f, { type: "amount", value: "9" })).toMatchObject({ amount: "1.79", all: true });
    expect(run(start("cash", "NVDAc"), { type: "amount", value: "5000" })).toEqual({
      legs: { from: "cash", to: "NVDAc" },
      amount: BACKER_MAX.toFixed(2),
      all: false,
    });
  });

  it("a new From drops MAX's all of it unless it's the same stock; a pick that makes no trade changes nothing", () => {
    const f = run(start("AMZNc", "cash"), { type: "max" });
    expect(run(f, { type: "pick", which: "to", asset: "XYZc" })).toEqual(f);
    expect(run(f, { type: "pick", which: "from", asset: "USDC" })).toEqual(f);
    const g = run(start("AMZNc", "NVDAc"), { type: "max" }, { type: "pick", which: "from", asset: "cash" });
    expect(g).toEqual({ legs: { from: "cash", to: "NVDAc" }, amount: "1.79", all: false });
    expect(run(start("AMZNc", "cash"), { type: "max" }, { type: "pick", which: "from", asset: "AMZNc" }).all).toBe(
      true,
    );
  });

  it("picking the other leg's asset flips the legs (so Cash never trades into Cash)", () => {
    expect(run(start("cash", "NVDAc", "20"), { type: "pick", which: "from", asset: "NVDAc" }).legs).toEqual({
      from: "NVDAc",
      to: "cash",
    });
    expect(run(start("AMZNc", "cash"), { type: "pick", which: "from", asset: "cash" }).legs).toEqual({
      from: "cash",
      to: "AMZNc",
    });
    expect(run(start("AMZNc", "NVDAc"), { type: "pick", which: "to", asset: "AMZNc" }).legs).toEqual({
      from: "NVDAc",
      to: "AMZNc",
    });
  });

  it("MAX on cash takes the cash less the fee buffer and never sells all of anything", () => {
    expect(run(start("cash", "NVDAc"), { type: "max" })).toEqual({
      legs: { from: "cash", to: "NVDAc" },
      amount: BACKER_MAX.toFixed(2),
      all: false,
    });
  });

  it("with nothing to trade only the amount moves", () => {
    const none: TradeForm = { legs: null, amount: "", all: false };
    expect(run(none, { type: "max" }, { type: "flip" }, { type: "pick", which: "to", asset: "NVDAc" })).toEqual(none);
    expect(run(none, { type: "amount", value: "5" })).toEqual({ legs: null, amount: "5", all: false });
  });
});

describe("planTrade: cash → stock", () => {
  const base = { from: "cash", to: "NVDAc", all: false, data: backer, now: OPEN } as const;

  it("at zero: no line, rows waiting, the button names the buy", () => {
    const v = planTrade({ ...base, amount: "" });
    expect(v).toMatchObject({
      route: "buy",
      fromLabel: "You pay",
      hint: ["Cash available: $1,939.18"],
      button: "Buy NVIDIA",
      note: null,
      ready: false,
    });
    expect(v.rows).toEqual([{ label: "You get at least", value: "—" }]);
    expect(v.youGet).toEqual({ kind: "stock", symbol: "NVDAc", shares: 0, priceUsd: 200 });
  });

  it("while quoting: … and the button waits; a quote for another amount is still quoting", () => {
    const v = planTrade({ ...base, amount: "100", buy: loading });
    expect(v.quoting).toBe(true);
    expect(v.youGet).toMatchObject({ shares: null });
    expect(v.rows[0].value).toBe("…");
    expect(v.ready).toBe(false);
    expect(planTrade({ ...base, amount: "100", buy: ready(buyQuoteFor("NVDAc", usd(90))) }).quoting).toBe(true);
  });

  it("ready: what you get, at least, and the price", () => {
    const q = buyQuoteFor("NVDAc", usd(100));
    const v = planTrade({ ...base, amount: "100", buy: ready(q) });
    expect(v.ready).toBe(true);
    expect(v.buyQuote).toBe(q);
    expect(v.rows).toEqual([
      { label: "You get at least", value: `${(Number(minOut(q.amountOut)) / 1e8).toFixed(4)} NVDA` },
    ]);
    expect(v.youGet).toMatchObject({ kind: "stock", shares: Number(q.amountOut) / 1e8 });
    expect((v.youGet as { priceUsd: number }).priceUsd).toBeCloseTo(200.6, 1);
    expect(v.note).toBeNull();
  });

  it("a refresh keeps the numbers but holds the button", () => {
    const v = planTrade({
      ...base,
      amount: "100",
      buy: { ...ready(buyQuoteFor("NVDAc", usd(100))), isFetching: true },
    });
    expect(v.quoting).toBe(false);
    expect(v.ready).toBe(false);
  });

  it("warns past 2% over the stock's price, blocks past 10%", () => {
    const warn = planTrade({ ...base, amount: "100", buy: ready(buyQuoteFor("NVDAc", usd(100), 0.024)) });
    expect(warn.note).toEqual({
      tone: "watch",
      text: "You’d pay 2.4% over the stock’s price — the market for NVIDIA is small.",
    });
    expect(warn.ready).toBe(true);
    const block = planTrade({ ...base, amount: "100", buy: ready(buyQuoteFor("NVDAc", usd(100), 0.123)) });
    expect(block.note).toEqual({
      tone: "act",
      text: "Too big for the market right now: you’d pay 12.3% over the stock’s price. Try a smaller amount.",
    });
    expect(block.ready).toBe(false);
  });

  it("blocks under $1, with no market, over the cash and with too little cash", () => {
    expect(planTrade({ ...base, amount: "0.5", buy: ready(buyQuoteFor("NVDAc", usd(0.5))) }).blocker).toBe(
      "Minimum buy is $1.00.",
    );
    expect(planTrade({ ...base, amount: "100", buy: noPool }).blocker).toBe("There’s no market for NVIDIA right now.");
    // The cash moved after the amount was typed.
    const less = { ...backer, cash: { walletRaw: usd(60), savingsRaw: 0n, saveOn: false }, cashUsd: 60 };
    expect(planTrade({ ...base, data: less, amount: (60 - B / 2).toFixed(2) }).blocker).toBe(
      `Leave ${formatUsd(B)} for the network fee.`,
    );
    expect(planTrade({ ...base, data: less, amount: "100" }).blocker).toBe("That’s more than your cash ($60.00).");
    const poor = {
      ...backer,
      cash: { walletRaw: usd(1 + B - 0.01), savingsRaw: 0n, saveOn: false },
      cashUsd: 1 + B - 0.01,
    };
    expect(planTrade({ ...base, data: poor, amount: "" }).note).toEqual({
      tone: "act",
      text: `You need at least ${formatUsd(1 + B)} in your cash to buy.`,
    });
  });

  it("says markets are closed at the weekend, and still goes ahead", () => {
    const v = planTrade({ ...base, amount: "100", buy: ready(buyQuoteFor("NVDAc", usd(100))), now: SATURDAY });
    expect(v.note).toEqual({
      tone: "watch",
      text: "Stock markets are closed. You can still trade, but the price can jump when they reopen.",
    });
    expect(v.ready).toBe(true);
    expect(planTrade({ ...base, amount: "", now: SATURDAY }).note).toBeNull();
  });
});

describe("planTrade: stock → cash", () => {
  const base = { from: "NVDAc", to: "cash", all: false, data: newcomer, now: OPEN } as const;

  it("ready: the free shares at Aave's price, what the sale pays at least, Sell NVIDIA", () => {
    const q = sellQuoteFor("NVDAc", 25_000_000n);
    const v = planTrade({ ...base, amount: "50", sell: ready(q) });
    expect(v).toMatchObject({
      route: "sell",
      fromLabel: "You sell",
      hint: ["Free to trade: $50.00"],
      button: "Sell NVIDIA",
      ready: true,
    });
    expect(v.sellPlan!.minOutRaw).toBe(sellMinOut(q, nvda, PRICE.NVDAc));
    expect(v.rows).toEqual([{ label: "You get at least", value: "$49.40" }]);
    expect(v.youGet).toMatchObject({ kind: "cash", usd: 49.9 });
  });

  it("blocks under $1, more than 10% under the stock's price, more than is free, and with no market", () => {
    expect(planTrade({ ...base, amount: "0.8" }).blocker).toBe("The smallest sale is $1.");
    const far = planTrade({ ...base, amount: "50", sell: ready(sellQuoteFor("NVDAc", 25_000_000n, 0.12)) });
    expect(far.blocker).toBe(
      "Too big for the market right now: you’d get more than 10% under the stock’s price. Try a smaller amount.",
    );
    const warn = planTrade({ ...base, amount: "50", sell: ready(sellQuoteFor("NVDAc", 25_000_000n, 0.024)) });
    expect(warn.note).toEqual({
      tone: "watch",
      text: "You’d get 2.4% under the stock’s price — the market for NVIDIA is small.",
    });
    // Free shares moved after the amount was typed.
    const fewer = {
      ...newcomer,
      holdings: newcomer.holdings.map((h) => (h.symbol === "NVDAc" ? holding("NVDAc", 20) : h)),
    };
    expect(planTrade({ ...base, data: fewer, amount: "50" }).blocker).toBe("That’s more than your free shares.");
    expect(planTrade({ ...base, amount: "50", sell: noPool }).blocker).toBe("There’s no market for NVIDIA right now.");
  });

  it("all of it backs credit: Free to trade $0.00, why, and no MAX", () => {
    const v = planTrade({ from: "NVDAc", to: "cash", amount: "", all: false, data: backer, now: OPEN });
    expect(v.hint).toEqual(["Free to trade: $0.00", "$2,500.00 of it backs your credit."]);
    expect(v.maxUsd).toBe(0);
    expect(v.note).toEqual({ tone: "act", text: "All of your NVIDIA backs your credit." });
  });

  it("some of it backs credit: the second line says how much", () => {
    const v = planTrade({ from: "AMZNc", to: "cash", amount: "", all: false, data: backer, now: OPEN });
    expect(v.hint).toEqual(["Free to trade: $1.80", "$1,721.43 of it backs your credit."]);
    expect(v.note).toBeNull();
  });

  it("a stock not held, after a flip: why", () => {
    expect(planTrade({ from: "AAPLc", to: "cash", amount: "10", all: false, data: backer, now: OPEN }).blocker).toBe(
      "You don’t have any Apple to trade.",
    );
  });
});

describe("planTrade: stock → stock", () => {
  const base = { from: "NVDAc", to: "AAPLc", all: false, data: newcomer, now: OPEN } as const;
  const shares = sharesForUsdRaw(usd(3), parseUnits("200", 8), 8);
  const sq = sellQuoteFor("NVDAc", shares);

  it("reads the buy for exactly the sale's floor, then is ready: Trade, what you get, and what stays in cash", () => {
    const pre = planTrade({ ...base, amount: "3", sell: ready(sq) });
    const floor = sellMinOut(sq, nvda, PRICE.NVDAc);
    expect(pre.buyInRaw).toBe(floor);
    expect(pre.quoting).toBe(true);
    expect(pre.ready).toBe(false);
    const bq = buyQuoteFor("AAPLc", floor);
    const v = planTrade({ ...base, amount: "3", sell: ready(sq), buy: ready(bq) });
    expect(v).toMatchObject({ route: "swap", fromLabel: "You sell", button: "Trade", ready: true, feeFromSale: false });
    expect(v.rows).toEqual([
      { label: "You get at least", value: `${(Number(minOut(bq.amountOut)) / 1e8).toFixed(4)} AAPL` },
      { label: "To your cash", value: `about $${(Number(sq.amountOut - floor) / 1e6).toFixed(2)}` },
    ]);
    expect(v.youGet).toMatchObject({ kind: "stock", symbol: "AAPLc", shares: Number(bq.amountOut) / 1e8 });
  });

  it("while the sale quotes, the buy waits; a buy read for another amount isn't used", () => {
    expect(planTrade({ ...base, amount: "3", sell: loading }).quoting).toBe(true);
    const v = planTrade({ ...base, amount: "3", sell: ready(sq), buy: ready(buyQuoteFor("AAPLc", usd(3))) });
    expect(v.buyQuote).toBeNull();
    expect(v.ready).toBe(false);
  });

  it("with cash under the fee buffer, the sale pays the fee: the buy is the floor less the buffer", () => {
    const short = {
      ...newcomer,
      cash: { walletRaw: shortRaw, savingsRaw: 0n, saveOn: false },
      cashUsd: Number(shortRaw) / 1e6,
    };
    const v = planTrade({ ...base, data: short, amount: "3", sell: ready(sq) });
    expect(v.feeFromSale).toBe(true);
    expect(v.buyInRaw).toBe(sellMinOut(sq, nvda, PRICE.NVDAc) - feeBufferRaw);
    // $1.05 can't make a $1 buy once the fee comes out of the sale.
    const small = sellQuoteFor("NVDAc", sharesForUsdRaw(usd(1.05), parseUnits("200", 8), 8));
    expect(planTrade({ ...base, data: short, amount: "1.05", sell: ready(small) }).blocker).toBe(
      `The smallest trade is ${formatUsd(swapMinUsd(0.998, true))}.`,
    );
    // With the fee from cash it can.
    expect(planTrade({ ...base, amount: "1.05", sell: ready(small) }).blocker).toBeNull();
  });

  it("blocks under the smallest trade, with no market for either stock, or far over the stock's price", () => {
    expect(planTrade({ ...base, amount: "0.6" }).blocker).toBe("The smallest trade is $1.10.");
    expect(planTrade({ ...base, amount: "3", sell: noPool }).blocker).toBe("There’s no market for NVIDIA right now.");
    expect(planTrade({ ...base, amount: "3", sell: ready(sq), buy: noPool }).blocker).toBe(
      "There’s no market for Apple right now.",
    );
    const floor = sellMinOut(sq, nvda, PRICE.NVDAc);
    const far = planTrade({ ...base, amount: "3", sell: ready(sq), buy: ready(buyQuoteFor("AAPLc", floor, 0.2)) });
    expect(far.blocker).toBe(
      "Too big for the market right now: you’d pay 20.0% over the stock’s price. Try a smaller amount.",
    );
    expect(far.ready).toBe(false);
  });

  it("Activity while it confirms reads the buy, then the sale, as the receipt does", () => {
    const pre = planTrade({ ...base, amount: "3", sell: ready(sq) });
    const bq = buyQuoteFor("AAPLc", pre.buyInRaw);
    expect(tradeActivity({ from: nvda, to: aapl, plan: pre.sellPlan!, buyQuote: bq })).toEqual([
      { kind: "buy", symbol: "AAPLc", amount: Number(bq.amountOut) / 1e8, paidUsd: Number(pre.buyInRaw) / 1e6 },
      { kind: "sell", symbol: "NVDAc", amount: Number(shares) / 1e8, receivedUsd: Number(sq.amountOut) / 1e6 },
    ]);
  });

  it("the small print says every move, both floors and what stays in cash", () => {
    const pre = planTrade({ ...base, amount: "3", sell: ready(sq) });
    const bq = buyQuoteFor("AAPLc", pre.buyInRaw);
    const text = swapSmallPrint({
      from: nvda,
      to: aapl,
      fromHolding: { priceUsd: 200, multiplier: 10n ** 18n },
      sellQuote: sq,
      plan: pre.sellPlan!,
      buyQuote: bq,
    });
    const floor = `$${(Number(pre.buyInRaw) / 1e6).toFixed(2)}`;
    expect(text).toBe(
      `In one go: exactly 0.015 NVDA is approved for the Aerodrome router and swapped for at least ${floor}, then exactly ${floor} is approved ` +
        `for the Aerodrome router and swapped for Apple. You get at least ${(Number(minOut(bq.amountOut)) / 1e8).toFixed(4)} AAPL. If either price ` +
        `moves more than 1%, the trade is cancelled, and NVIDIA never sells for more than 10% under Aave’s price ($200.00). What the sale brings ` +
        `above ${floor} stays in your cash. NVIDIA and Apple here are tokenized stocks. They track the share price; they are not company shares or voting rights.`,
    );
  });

  it("Amazon's free shares into NVIDIA on the backer: the From card says what backs credit", () => {
    const v = planTrade({ from: "AMZNc", to: "NVDAc", amount: "1.8", all: true, data: backer, now: OPEN });
    expect(v.sharesRaw).toBe(backer.holdings.find((h) => h.symbol === "AMZNc")!.freeRaw);
    expect(v.hint).toEqual(["Free to trade: $1.80", "$1,721.43 of it backs your credit."]);
    expect(v.route).toBe("swap");
  });
});

describe("useTrade: the stock → stock batch at signing (swapBatch)", () => {
  const shares = sharesForUsdRaw(usd(3), parseUnits("200", 8), 8);
  const sq = sellQuoteFor("NVDAc", shares);
  const pre = planTrade({
    from: "NVDAc",
    to: "AAPLc",
    amount: "3",
    all: false,
    data: newcomer,
    sell: ready(sq),
    now: OPEN,
  });
  const bq = buyQuoteFor("AAPLc", pre.buyInRaw);
  const sign = (over: Partial<Parameters<typeof swapBatch>[0]> = {}): Parameters<typeof swapBatch>[0] => ({
    route: "swap",
    user,
    from: nvda,
    to: aapl,
    sellQuote: sq,
    plan: pre.sellPlan!,
    buyQuote: bq,
    oraclePriceUsd: PRICE.NVDAc,
    feeFromSale: false,
    ...over,
  });
  /** The signing reads: the quotes as shown unless `fresh` says otherwise, and the cash as given. */
  const reads = (cash: Cash, fresh: { sell?: SellQuote; buy?: BuyQuote } = {}) => {
    const r = {
      quoteToSign: vi.fn(async (_stock: unknown, shown: BuyQuote, side?: "buy" | "sell") =>
        side === "sell" ? (fresh.sell ?? shown) : (fresh.buy ?? shown),
      ),
      cashToSign: vi.fn(async () => cash),
    };
    return r as typeof r & SwapReads;
  };
  const rich: Cash = { walletRaw: usd(40), savingsRaw: 0n, saveOn: false };

  it("a sale the screen blocked stops before any read, with the screen's words", async () => {
    const r = reads(rich);
    const blocked = swapBatch(sign({ plan: { ...pre.sellPlan!, block: "too-small" } }), r);
    await expect(blocked).rejects.toBeInstanceOf(TxStop);
    await expect(blocked).rejects.toThrow("The smallest trade is $1.10.");
    await expect(swapBatch(sign({ plan: { ...pre.sellPlan!, block: "price" } }), r)).rejects.toThrow(
      /Too big for the market right now/,
    );
    expect(r.quoteToSign).not.toHaveBeenCalled();
    expect(r.cashToSign).not.toHaveBeenCalled();
  });

  it("reads both quotes again, the sale's as a sale and the buy's as a buy", async () => {
    const r = reads(rich);
    await swapBatch(sign(), r);
    expect(r.quoteToSign).toHaveBeenCalledWith(nvda, sq, "sell");
    expect(r.quoteToSign).toHaveBeenCalledWith(aapl, bq, "buy");
  });

  it("stops with QUOTE_MOVED when the fresh sale's floor no longer covers the buy", async () => {
    const lower = { ...sq, amountOut: sq.amountOut - 50_000n }; // the pool now pays 5 cents less
    expect(sellMinOut(lower, nvda, PRICE.NVDAc)).toBeLessThan(bq.amountIn);
    const r = reads(rich, { sell: lower });
    const moved = swapBatch(sign(), r);
    await expect(moved).rejects.toBeInstanceOf(TxStop);
    await expect(moved).rejects.toThrow(QUOTE_MOVED);
    expect(r.cashToSign).not.toHaveBeenCalled();
  });

  it("a read that stops (the price fell under the screen's floor) stops the batch with its words", async () => {
    const r = reads(rich);
    r.quoteToSign.mockRejectedValueOnce(new TxStop(QUOTE_MOVED));
    await expect(swapBatch(sign(), r)).rejects.toThrow(QUOTE_MOVED);
  });

  it("when the sale pays the fee, the batch is the sale and the buy alone, and the cash isn't read", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const r = reads({ walletRaw: shortRaw, savingsRaw: 0n, saveOn: false });
    const calls = await swapBatch(sign({ feeFromSale: true }), r);
    now.mockRestore();
    expect(calls).toEqual(
      buildTradeCalls({
        user,
        from: nvda,
        to: aapl,
        sellQuote: sq,
        buyQuote: bq,
        oraclePriceUsd: PRICE.NVDAc,
        nowSec: 1_800_000_000,
      }),
    );
    expect(calls).toHaveLength(4);
    expect(r.cashToSign).not.toHaveBeenCalled();
  });

  it("when the cash pays the fee, it's read again with nothing to spend but the fee; savings come out first if the wallet is short", async () => {
    const r = reads(rich);
    expect(await swapBatch(sign(), r)).toHaveLength(4);
    expect(r.cashToSign).toHaveBeenCalledWith(user, 0n);
    const short = await swapBatch(sign(), reads({ walletRaw: shortRaw, savingsRaw: usd(50), saveOn: false }));
    expect(short).toHaveLength(5);
    expect(short[0].to).toBe(GUARDIAN.AAVE_V3_POOL);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: short[0].data }).args).toEqual([
      USDC.address,
      feeBufferRaw - shortRaw,
      user,
    ]);
  });

  it("the cash read's stop (the cash moved since the screen) stops the batch", async () => {
    const r = reads(rich);
    r.cashToSign.mockRejectedValueOnce(new TxStop("cash short"));
    await expect(swapBatch(sign(), r)).rejects.toThrow("cash short");
  });
});

describe("words on the main screen", () => {
  const BANNED = /aave|uniswap|aerodrome|slippage|borrow|loan|lock|face id|apy/i;
  const words = Object.values(TRADE_COPY).map((v) =>
    typeof v === "function" ? (v as (...a: unknown[]) => string)("1.0", "NVIDIA") : v,
  );

  it("name no protocol, never borrow, loan or lock, no APY and never “with Face ID”", () => {
    for (const w of words) expect(w).not.toMatch(BANNED);
  });

  it("the buttons name the action only", () => {
    expect([TRADE_COPY.buyButton("Apple"), TRADE_COPY.sellButton("NVIDIA"), TRADE_COPY.tradeButton]).toEqual([
      "Buy Apple",
      "Sell NVIDIA",
      "Trade",
    ]);
    for (const v of [
      planTrade({ from: "cash", to: "AAPLc", amount: "", all: false, data: newcomer }),
      planTrade({ from: "TSLAc", to: "METAc", amount: "", all: false, data: newcomer }),
    ]) {
      expect(v.button).not.toMatch(BANNED);
    }
  });

  it("every line planTrade can show is free of them too", () => {
    const lines = [
      planTrade({
        from: "NVDAc",
        to: "cash",
        amount: "50",
        all: false,
        data: newcomer,
        sell: ready(sellQuoteFor("NVDAc", 25_000_000n, 0.12)),
        now: OPEN,
      }).blocker,
      planTrade({
        from: "NVDAc",
        to: "cash",
        amount: "50",
        all: false,
        data: newcomer,
        sell: ready(sellQuoteFor("NVDAc", 25_000_000n, 0.03)),
        now: OPEN,
      }).warn,
      planTrade({
        from: "cash",
        to: "NVDAc",
        amount: "100",
        all: false,
        data: newcomer,
        buy: ready(buyQuoteFor("NVDAc", usd(100), 0.2)),
        now: OPEN,
      }).blocker,
      ...planTrade({ from: "AMZNc", to: "cash", amount: "", all: false, data: backer }).hint,
    ];
    for (const l of lines) expect(l).not.toMatch(BANNED);
  });
});

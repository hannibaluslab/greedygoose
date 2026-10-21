import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, parseUnits } from "viem";
import { TxStop } from "@/hooks/useTx";
import { swapOf } from "@/lib/allowlist";
import { feeBufferRaw, type Cash } from "@/lib/cash";
import { PROTOCOLS } from "@/lib/protocols/config";
import { buildAddSavingsCalls } from "@/lib/savings";
import { assertSalesCoverSave } from "@/lib/sell/covers";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { QUOTE_MOVED, type BuyQuote } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { MULTI_COPY, planTrade, sharesForUsdRaw, type TradeData, type TradeHolding } from "@/lib/trade";
import { multiActivity, multiBlock, multiTradeBatch, type SwapReads, type TradeSign } from "@/lib/tx/plans";

/*
 * Multi trade (lib/trade/multi.ts, lib/tx/plans/multiTrade.ts): the rows checked together, then one batch of every
 * row's own calls, from fresh quotes, through the allowlist.
 */

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const stock = (symbol: string) => EQUITIES.find((e) => e.symbol === symbol)!;
const PRICE: Record<string, number> = {
  AAPLc: 250,
  AMZNc: 225,
  GOOGLc: 240,
  METAc: 700,
  MSFTc: 500,
  NVDAc: 200,
  TSLAc: 400,
};
const OPEN = new Date("2026-10-14T15:00:00Z");

function holding(symbol: string, freeUsd = 0): TradeHolding {
  const p = PRICE[symbol];
  const freeRaw = BigInt(Math.round((freeUsd / p) * 1e8));
  return {
    symbol,
    name: stock(symbol).name,
    priceUsd: p,
    priceRaw: parseUnits(p.toFixed(8), 8),
    freeRaw,
    backingRaw: 0n,
    freeUsd: (Number(freeRaw) / 1e8) * p,
    backingUsd: 0,
    freeShares: Number(freeRaw) / 1e8,
    backingShares: 0,
    multiplier: 10n ** 18n,
    paused: false,
  };
}
const account = (cash: Cash, free: Record<string, number>): TradeData => ({
  holdings: EQUITIES.map((e) => holding(e.symbol, free[e.symbol] ?? 0)),
  cash,
  cashUsd: Number(cash.walletRaw + cash.savingsRaw) / 1e6,
  totalBackingUsd: 0,
  avgCf: 0.7,
  debtUsd: 0,
  debtRaw: 0n,
  healthFactor: null,
});
const ready = <Q>(data: Q) => ({ data, isFetching: false, isSuccess: true });
const buyQuoteFor = (symbol: string, amountIn: bigint): BuyQuote => ({
  venue: "aerodrome",
  pool: 10,
  amountIn,
  amountOut: BigInt(Math.floor((Number(amountIn) / 1e6 / (PRICE[symbol] * 1.003)) * 1e8)),
});
const sellQuoteFor = (symbol: string, sharesRaw: bigint): SellQuote => ({
  venue: "aerodrome",
  pool: 10,
  amountIn: sharesRaw,
  amountOut: BigInt(Math.floor((Number(sharesRaw) / 1e8) * PRICE[symbol] * 0.998 * 1e6)),
});

// $40 in the wallet, $60 in savings; free NVIDIA, Microsoft and Apple.
const cash: Cash = { walletRaw: usd(40), savingsRaw: usd(60), saveOn: false };
const data = account(cash, { NVDAc: 50, MSFTc: 30, AAPLc: 20 });

/** One row as the Trade sheet signs it, through the sheet's own plan. */
function sign(from: string, to: string, amount: number): TradeSign {
  const base = { from, to, amount: String(amount), all: false, data, now: OPEN };
  if (from === "cash") {
    const v = planTrade({ ...base, buy: ready(buyQuoteFor(to, usd(amount))) });
    return { route: "buy", user, stock: v.toStock!, quote: v.buyQuote!, oraclePriceUsd: PRICE[to] };
  }
  const shares = sharesForUsdRaw(usd(amount), parseUnits(PRICE[from].toFixed(8), 8), 8);
  const sell = ready(sellQuoteFor(from, shares));
  if (to === "cash") {
    const v = planTrade({ ...base, sell });
    return {
      route: "sell",
      user,
      stock: v.fromStock!,
      quote: v.sellQuote!,
      plan: v.sellPlan!,
      oraclePriceUsd: PRICE[from],
      debtRaw: 0n,
    };
  }
  const pre = planTrade({ ...base, sell });
  const v = planTrade({ ...base, sell, buy: ready(buyQuoteFor(to, pre.buyInRaw)) });
  return {
    route: "swap",
    user,
    from: v.fromStock!,
    to: v.toStock!,
    sellQuote: v.sellQuote!,
    plan: v.sellPlan!,
    buyQuote: v.buyQuote!,
    oraclePriceUsd: PRICE[from],
    toPriceUsd: PRICE[to],
    feeFromSale: v.feeFromSale,
  };
}

const reads = (c: Cash = cash, fresh: (q: BuyQuote, side?: "buy" | "sell") => BuyQuote = (q) => q) => {
  const r = {
    quoteToSign: vi.fn(async (_s: unknown, shown: BuyQuote, side?: "buy" | "sell") => fresh(shown, side)),
    cashToSign: vi.fn(async () => c),
  };
  return r as typeof r & SwapReads;
};

describe("the rows together", () => {
  it("can go ahead when the buys fit the cash and the sales fit the free shares", () => {
    expect(
      multiBlock([sign("cash", "AAPLc", 30), sign("NVDAc", "cash", 20), sign("MSFTc", "TSLAc", 10)], data),
    ).toBeNull();
  });

  it("stops buys that together spend more than the cash, the fuel tank kept back", () => {
    expect(multiBlock([sign("cash", "AAPLc", 60), sign("cash", "NVDAc", 40)], data)).toMatch(/more than your cash/);
  });

  it("stops rows that together sell more of a stock than is free, a sale and a trade from it alike", () => {
    expect(multiBlock([sign("NVDAc", "cash", 30), sign("NVDAc", "AAPLc", 25)], data)).toBe(
      MULTI_COPY.overShares(stock("NVDAc").name),
    );
  });

  it("asks for the network fee when the cash can't keep it", () => {
    const poor = { ...data, cash: { walletRaw: feeBufferRaw - 1n, savingsRaw: 0n, saveOn: false } };
    expect(multiBlock([sign("NVDAc", "cash", 10), sign("MSFTc", "cash", 10)], poor)).toBe(MULTI_COPY.fee);
  });
});

describe("one batch for every row", () => {
  const signs = [sign("cash", "AAPLc", 50), sign("NVDAc", "cash", 20), sign("MSFTc", "TSLAc", 10)];

  it("buys, then trades, then sales, then one savings supply of what the sales are sure to bring", async () => {
    const r = reads();
    const calls = await multiTradeBatch(user, signs, r);
    // $50 of buys against $40 in the wallet: savings pay the rest first.
    const first = decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data });
    expect(calls[0].to).toBe(PROTOCOLS.AAVE_V3_POOL);
    expect(first.functionName).toBe("withdraw");
    const swaps = calls.filter((c) => swapOf(c));
    expect(swaps.map((c) => swapOf(c)!.params.tokenOut)).toEqual([
      stock("AAPLc").address, // the buy
      USDC.address, // the trade's sale…
      stock("TSLAc").address, // …and its buy
      USDC.address, // the sale
    ]);
    const supply = calls[calls.length - 1];
    const s = decodeFunctionData({ abi: aaveV3PoolAbi, data: supply.data });
    expect(s.functionName).toBe("supply");
    const sale = signs[1] as Extract<TradeSign, { route: "sell" }>;
    expect(s.args[1]).toBe(sellMinOut(sale.quote, sale.stock, sale.oraclePriceUsd));
    // Its approval is exact.
    const approve = calls[calls.length - 2];
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([PROTOCOLS.AAVE_V3_POOL, s.args[1]]);
  });

  it("refuses a savings supply above what the sales are sure to bring", async () => {
    const calls = await multiTradeBatch(user, signs, reads());
    const supply = decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[calls.length - 1].data });
    const more = [...calls.slice(0, -2), ...buildAddSavingsCalls(user, (supply.args[1] as bigint) + 1n)];
    expect(() => assertSalesCoverSave(user, more, 1)).toThrow(/more than the sales are sure to bring/);
    // Counting the trade's own sale as one into cash doesn't help: the supply must follow sales the list made.
    expect(() => assertSalesCoverSave(user, calls, 3)).toThrow(/sales into USDC/);
  });

  it("reads every quote again, and the cash for the buys together", async () => {
    const r = reads();
    await multiTradeBatch(user, signs, r);
    expect(r.quoteToSign).toHaveBeenCalledTimes(4);
    expect(r.cashToSign).toHaveBeenCalledWith(user, usd(50));
  });

  it("stops with QUOTE_MOVED when a trade's fresh sale no longer covers its buy", async () => {
    const r = reads(cash, (q, side) => (side === "sell" ? { ...q, amountOut: q.amountOut / 2n } : q));
    const moved = multiTradeBatch(user, [sign("MSFTc", "TSLAc", 10), sign("cash", "AAPLc", 5)], r);
    await expect(moved).rejects.toBeInstanceOf(TxStop);
    await expect(moved).rejects.toThrow(QUOTE_MOVED);
  });

  it("stops a row the screen blocked before any read", async () => {
    const blocked = sign("NVDAc", "cash", 20) as Extract<TradeSign, { route: "sell" }>;
    const r = reads();
    await expect(
      multiTradeBatch(user, [{ ...blocked, plan: { ...blocked.plan, block: "price" } }, signs[0]], r),
    ).rejects.toThrow(/Too big for the market right now/);
    expect(r.quoteToSign).not.toHaveBeenCalled();
  });

  it("puts nothing into savings when no row sells to cash", async () => {
    const calls = await multiTradeBatch(user, [sign("cash", "AAPLc", 10), sign("cash", "NVDAc", 10)], reads());
    expect(
      calls.some(
        (c) =>
          c.to === PROTOCOLS.AAVE_V3_POOL &&
          decodeFunctionData({ abi: aaveV3PoolAbi, data: c.data }).functionName === "supply",
      ),
    ).toBe(false);
  });

  it("shows every row in Activity while it confirms", () => {
    expect(multiActivity(signs).map((a) => a.kind)).toEqual(["buy", "sell", "buy", "sell"]);
  });
});

import { parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { fullRepayAmount } from "@/lib/aave/tx";
import { cashRaw, feeBufferRaw, feeFromSale, maxSpendRaw, toUsd, type Cash } from "@/lib/cash";
import { ceilCents, floorCents } from "@/lib/formatting";
import { homeStatus, statusFor, type Status } from "@/lib/risk/status";
import { freeRepayRaw, repaySaleMaxRaw, saleRepayRaw, type SellPosition } from "@/lib/sell";
import { SLIP_KEEP } from "@/lib/swap/buy";
import { SELL_LIMITS, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { EQUITIES, USDC, stockRank, type ReserveAsset } from "@/lib/tokens/registry";
import { REPAY_COPY } from "./copy";

/** The holding's fields Repay reads (usePosition's Holding has them all). */
export type RepayHolding = {
  symbol: string;
  name: string;
  priceUsd: number;
  freeRaw: bigint;
  backingRaw: bigint;
  freeUsd: number;
  backingUsd: number;
  paused: boolean;
  multiplier: bigint;
};

/** The position's fields Repay reads (usePosition's data has them all). */
export type RepayData = SellPosition & { holdings: RepayHolding[]; cash: Cash; cashUsd: number; status: Status };

type RepayKind = "cash" | "free" | "backing";

/** A "Pay with" row: what it is, and the most it can sell and repay. */
export type RepaySource = {
  /** "cash", "free:NVDAc" or "backing:NVDAc". */
  id: string;
  kind: RepayKind;
  name: string;
  /** What it is, under the name: "$1,941.41 in your cash", "$5.68 free", "$2,574.15 backs your credit". */
  sub: string;
  stock?: ReserveAsset;
  holding?: RepayHolding;
  /** The stock's collateral factor (backing only; 0 otherwise). */
  cf: number;
  /** The most shares it can sell, raw: all the free shares, or the backing that can come out before the repay lands. */
  maxSharesRaw: bigint;
  /** Those shares at Aave's price (0 for cash). */
  valueUsd: number;
  /** The network fee comes out of the sale: always for backing (saleRepayRaw), for a free stock when the cash can't keep its buffer. */
  feeFromSale: boolean;
  /** Before its quote: the most it can repay, at Aave's price less the swap's 1%, less the fee when the sale pays it; never more than owed. */
  estUsd: number;
};

/**
 * A row is listed only if it can still repay $1 when its pool pays up to this much under Aave's price, so a stock that
 * only just reaches $1 at Aave's price isn't offered and then quoted under it.
 */
const LIST_POOL_ALLOWANCE = 0.99;
/** The smallest repay: a cent, or all of it when less is owed. */
/** A cent: no minimum of ours (ruling 2, Oct 17); Aave's own rule against tiny debt still applies. */
const MIN_REPAY_USD = 0.01;
export const minRepayUsd = (debtUsd: number) => Math.min(MIN_REPAY_USD, debtUsd);

export const usdcRaw = (usd: number) => parseUnits(Math.max(0, usd).toFixed(USDC.decimals), USDC.decimals);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const stockOf = (symbol: string) => EQUITIES.find((e) => e.symbol === symbol);
/** Dollars to the cent: up for a full repay (what's owed is never shown as less), down otherwise. */
export const toCents = (usd: number, up: boolean) => (up ? ceilCents(usd) : floorCents(usd));

/**
 * "Pay with", in Adrian's order: the cash, then each stock held free, then each stock that backs the credit; within each
 * group the one that can repay the most first. Only rows that can repay at least $1 (or all of it, when less is owed)
 * are listed. A free stock needs $1 of shares to sell; a backing stock lists the shares that can come out before the
 * repay lands (planSell's near-limit guard), and none while it's paused or its collateral factor isn't read yet. Nothing
 * while nothing is owed.
 */
export function repaySources(data: RepayData, cfs: Record<string, number> | undefined): RepaySource[] {
  if (data.debtRaw <= 0n) return [];
  const fee = CASH.feeBufferUsd;
  const fromSale = feeFromSale(data.cash);
  const cap = (usd: number) => Math.max(0, Math.min(usd, data.debtUsd));
  const cash: RepaySource = {
    id: "cash",
    kind: "cash",
    name: REPAY_COPY.cash,
    sub: REPAY_COPY.cashSub(data.cashUsd),
    cf: 0,
    maxSharesRaw: 0n,
    valueUsd: 0,
    feeFromSale: false,
    estUsd: cap(toUsd(maxSpendRaw(data.cash))),
  };
  const free = data.holdings.flatMap((h): RepaySource[] => {
    const stock = stockOf(h.symbol);
    if (!stock || h.freeRaw === 0n || h.freeUsd < SELL_LIMITS.minUsd) return [];
    return [
      {
        id: `free:${h.symbol}`,
        kind: "free",
        name: h.name,
        sub: REPAY_COPY.freeSub(h.freeUsd),
        stock,
        holding: h,
        cf: 0,
        maxSharesRaw: h.freeRaw,
        valueUsd: h.freeUsd,
        feeFromSale: fromSale,
        estUsd: cap(h.freeUsd * SLIP_KEEP - (fromSale ? fee : 0)),
      },
    ];
  });
  const backing = data.holdings.flatMap((h): RepaySource[] => {
    const stock = stockOf(h.symbol);
    const cf = cfs?.[h.symbol];
    if (!stock || !cf || h.backingRaw === 0n || h.paused) return [];
    const maxSharesRaw = repaySaleMaxRaw(h, cf, data);
    const valueUsd = (Number(maxSharesRaw) / 10 ** stock.decimals) * h.priceUsd;
    if (valueUsd < SELL_LIMITS.minUsd) return [];
    return [
      {
        id: `backing:${h.symbol}`,
        kind: "backing",
        name: h.name,
        sub: REPAY_COPY.backsSub(h.backingUsd),
        stock,
        holding: h,
        cf,
        maxSharesRaw,
        valueUsd,
        feeFromSale: true,
        estUsd: cap(valueUsd * SLIP_KEEP - fee),
      },
    ];
  });
  // Cash, the free stocks, then the ones that back credit (board 8), each group in Home's order (ruling 43).
  const inOrder = (a: RepaySource, b: RepaySource) => stockRank(a.stock!.symbol) - stockRank(b.stock!.symbol);
  const min = minRepayUsd(data.debtUsd);
  // A stock's estimate with its pool paying up to 1% under Aave's price (LIST_POOL_ALLOWANCE); the cash is exact.
  const canRepay = (s: RepaySource) =>
    s.kind === "cash" ? s.estUsd : cap(s.valueUsd * SLIP_KEEP * LIST_POOL_ALLOWANCE - (s.feeFromSale ? fee : 0));
  return [cash, ...free.sort(inOrder), ...backing.sort(inOrder)].filter(
    (s) => s.estUsd > 0 && canRepay(s) >= min - 1e-9,
  );
}

/** The row on screen: the one picked while it's still listed, else the first (the cash when it can repay $1). */
export const pickedSource = (sources: RepaySource[], id: string | null) =>
  sources.find((s) => s.id === id) ?? sources[0] ?? null;

/** Why nothing can repay (no row listed while something is owed): no money at all, or not enough cash. */
export function noSourceLine(data: Pick<RepayData, "cash" | "debtUsd" | "holdings">): string {
  const holdsStock = data.holdings.some((h) => h.freeRaw + h.backingRaw > 0n);
  if (cashRaw(data.cash) === 0n && !holdsStock) return REPAY_COPY.noCash;
  return REPAY_COPY.tooLittle(minRepayUsd(data.debtUsd) + CASH.feeBufferUsd);
}

/** The most a source repays: dollars (never more than owed), raw USDC, and whether that is all that's owed. */
export type RepayMax = { usd: number; raw: bigint; coversAll: boolean; quoting: boolean };

/**
 * The most a source repays. Cash: all of it less the fee buffer, or a full repay (what's owed plus Aave's interest
 * buffer) when it covers it. A stock, from the quote for all its shares (`maxQuote`): what that sale is sure to bring,
 * as its batch would repay it (`freeRepayRaw`, or `saleRepayRaw` from backing). Before that quote, the row's estimate.
 */
export function repayMax(
  source: RepaySource,
  data: Pick<RepayData, "cash" | "debtRaw" | "debtUsd">,
  maxQuote?: SellQuote | null,
): RepayMax {
  if (source.kind === "cash") {
    const spend = maxSpendRaw(data.cash);
    return {
      usd: Math.min(toUsd(spend), data.debtUsd),
      raw: fullRepayAmount(data.debtRaw, spend),
      coversAll: spend >= data.debtRaw,
      quoting: false,
    };
  }
  if (!maxQuote || !source.stock || !source.holding) {
    return {
      usd: source.estUsd,
      raw: usdcRaw(source.estUsd),
      coversAll: source.estUsd >= data.debtUsd,
      quoting: !maxQuote && maxQuote !== null,
    };
  }
  const floor = sellMinOut(maxQuote, source.stock, source.holding.priceUsd);
  const raw =
    source.kind === "free" ? freeRepayRaw(floor, data.debtRaw, source.feeFromSale) : saleRepayRaw(floor, data.debtRaw);
  return { usd: Math.min(toUsd(raw), data.debtUsd), raw, coversAll: raw > data.debtRaw, quoting: false };
}

/** The dollars All shows: what's owed rounded up to the cent when it covers it, else the most it repays rounded down. */
export const allText = (max: RepayMax) => (max.usd > 0 ? toCents(max.usd, max.coversAll).toFixed(2) : "");

/**
 * Shares to sell for a repay of `targetRaw`. The quote for all the shares the row can sell (`maxQuote`) gives the floor
 * per share at the largest size; a smaller sale in the same pools gets at least that per share, so these shares bring at
 * least the target (plus the fee buffer when the sale pays it), with a hair over it (0.01% and 10 units) for the
 * quoter's rounding and a tick between the two quotes. A full repay adds 0.25%, so a price tick still repays all of it
 * (the rest stays as cash). At least a $1 sale; never more than the row can sell.
 */
export function sharesForRepay(p: {
  targetRaw: bigint;
  full: boolean;
  feeFromSale: boolean;
  maxSharesRaw: bigint;
  maxQuote: SellQuote;
  /** sellMinOut of maxQuote. */
  maxFloorRaw: bigint;
}): bigint {
  if (p.maxFloorRaw <= 0n || p.maxSharesRaw <= 0n || p.maxQuote.amountOut <= 0n) return 0n;
  let need = p.targetRaw + (p.feeFromSale ? feeBufferRaw : 0n);
  // A hair over (0.01% and 10 units) for the quoter's rounding and a tick between the two quotes; 0.25% on a full repay.
  need += p.full ? need / 400n : need / 10_000n + 10n;
  const forRepay = ceilDiv(need * p.maxSharesRaw, p.maxFloorRaw);
  const forSale = ceilDiv(((usdcRaw(SELL_LIMITS.minUsd) * 101n) / 100n) * p.maxSharesRaw, p.maxQuote.amountOut);
  const shares = forRepay > forSale ? forRepay : forSale;
  return shares < p.maxSharesRaw ? shares : p.maxSharesRaw;
}

/** The status a repay of `usd` from `source` would land in, as Home shows it (nothing owed reads Safe). */
export function statusAfter(
  source: RepaySource,
  usd: number,
  data: Pick<RepayData, "totalBackingUsd" | "avgCf" | "debtUsd" | "status">,
): Exclude<Status, "none"> {
  const r = Math.min(usd, source.estUsd);
  if (r <= 0) return homeStatus(data.status);
  if (r >= data.debtUsd - 0.005) return "safe";
  const weighted = data.totalBackingUsd * data.avgCf;
  // A backing stock takes out the shares that bring r and the fee: (r + fee) at Aave's price less the swap's 1%.
  const removed = source.kind === "backing" ? ((r + CASH.feeBufferUsd) / SLIP_KEEP) * source.cf : 0;
  return homeStatus(statusFor((weighted - removed) / (data.debtUsd - r)));
}

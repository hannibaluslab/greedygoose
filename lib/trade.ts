import { parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
import { buildWithdrawCalls } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, maxSpendRaw, toUsd, type Cash } from "@/lib/cash";
import { formatShares, formatUsd } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import {
  NO_DUST_USD,
  SELL_BLOCKED,
  planSell,
  sellableRaw,
  takeOutWords,
  type SellBlock,
  type SellPlan,
  type SellPosition,
} from "@/lib/sell";
import { BUY_LIMITS, buildBuyCalls, minOut, quoteEconomics, type BuyQuote, type Call } from "@/lib/swap/buy";
import { SELL_LIMITS, buildSellCalls, sellEconomics, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, byStockOrder, stockRank, type ReserveAsset } from "@/lib/tokens/registry";

/**
 * The Trade sheet (Adrian, 2026-10-15): NYM's MoveSheet in the GreedyGoose kit. From is Cash or a stock's free shares,
 * To is Cash or any of the seven stocks, and one batch does it: cash → stock is the Buy step's batch, stock → cash the
 * free-shares sale, stock → stock a sale and then a buy that spends exactly what the sale is sure to bring. Everything
 * the sheet shows comes from `planTrade`; the sheet holds no money maths.
 */

type Address = `0x${string}`;

/** "cash", or one of the seven stocks' registry symbols (resolved through the registry only, `stockOf`). */
export type TradeAsset = "cash" | (string & {});
export type TradeRoute = "buy" | "sell" | "swap";

/** The holding's fields the Trade sheet reads (usePosition's Holding has them all). */
export type TradeHolding = {
  symbol: string;
  name: string;
  priceUsd: number;
  /** Aave's price, 8 decimals. */
  priceRaw: bigint;
  freeRaw: bigint;
  backingRaw: bigint;
  freeUsd: number;
  backingUsd: number;
  freeShares: number;
  backingShares: number;
  multiplier: bigint;
  paused: boolean;
  /** The stock's collateral factor (useBackingFactors): with it, a stock that backs credit trades Up to $X. */
  cf?: number;
};

/** The position's fields the Trade sheet reads (usePosition's data has them all). */
export type TradeData = SellPosition & { holdings: TradeHolding[]; cash: Cash; cashUsd: number };

/**
 * The line under an amount: a sentence for cash, or for a stock (canvas boards 9–11) the dollars typed in shares at
 * Aave's price and the most it can be, Up to $X.
 */
export type AmountHint = string | { shares: number; priceUsd: number; upToUsd: number };

const usdcRaw = (usd: number) => parseUnits(usd.toFixed(USDC.decimals), USDC.decimals);
const MIN_BUY_RAW = usdcRaw(BUY_LIMITS.minUsd);
const tickerOf = (symbol: string) => symbol.replace(/c$/, "");
const held = (h: TradeHolding) => h.freeRaw + h.backingRaw > 0n;
const valueOf = (h: TradeHolding) => h.freeUsd + h.backingUsd;

/** A stock from the registry, never from a string alone; undefined for cash or anything else. */
export const stockOf = (a: TradeAsset): ReserveAsset | undefined =>
  a === "cash" ? undefined : EQUITIES.find((e) => e.symbol === a);

/** cash → stock is a buy, stock → cash a sale, stock → stock a swap; the same asset on both sides is no trade. */
export function routeOf(from: TradeAsset, to: TradeAsset): TradeRoute | null {
  if (from === to) return null;
  const f = from === "cash" ? "cash" : stockOf(from) ? "stock" : null;
  const t = to === "cash" ? "cash" : stockOf(to) ? "stock" : null;
  if (!f || !t) return null;
  if (f === "cash") return t === "stock" ? "buy" : null;
  return t === "cash" ? "sell" : "swap";
}

/** Raw shares that `usdRaw` (USDC, 6 decimals) buys at Aave's `priceRaw` (8 decimals), rounded down; 0 at no price. */
export function sharesForUsdRaw(usdRaw: bigint, priceRaw: bigint, decimals: number): bigint {
  if (priceRaw <= 0n || usdRaw <= 0n) return 0n;
  return (usdRaw * 10n ** BigInt(decimals + ORACLE_DECIMALS - USDC.decimals)) / priceRaw;
}

/** What a stock can trade now: its free shares, plus the backing the 1.12 line lets out when its factor is known. */
/**
 * What a stock can trade or send now (Up to $X): its free shares, plus the backing the 1.12 line lets out once its
 * factor and the credit are read. Without them, the free shares only.
 */
export const sellableOf = (h: TradeHolding, data: object) => {
  const pos = positionOf(data);
  return pos ? sellableRaw(h, h.cf, pos) : h.freeRaw;
};
const sellable = sellableOf;

/** Cents what a stock can trade is worth at Aave's price, rounded down: what MAX shows (Up to $X). */
const sellableCents = (h: TradeHolding, stock: ReserveAsset, data: object) =>
  (sellable(h, data) * h.priceRaw) / 10n ** BigInt(stock.decimals + ORACLE_DECIMALS - 2);

/** The cash can't keep the network-fee buffer, so a stock → stock sale pays its own fee. */
export const feeFromSale = (cash: Cash) => cash.walletRaw + cash.savingsRaw < feeBufferRaw;

/**
 * What the buy in a stock → stock trade spends: exactly the sale's floor, which the router guarantees reaches the
 * user first, so the trade never spends cash the user already had. When the cash can't pay the network fee, the
 * buffer stays out of the buy and the sale pays the fee (as `saleRepayRaw` does). Never negative.
 */
export function swapBuyInRaw(sellFloorRaw: bigint, cash: Cash): bigint {
  const buyIn = feeFromSale(cash) ? sellFloorRaw - feeBufferRaw : sellFloorRaw;
  return buyIn > 0n ? buyIn : 0n;
}

/**
 * The smallest stock → stock trade, in dollars at Aave's price: its buy must reach BUY_LIMITS.minUsd from the sale's
 * floor (the quote less 1%), plus the fee buffer when the sale pays the fee. `rate` is what the pool pays per dollar at
 * Aave's price (1 before a quote). Rounded up to the cent, and never under the smallest sale.
 */
export function swapMinUsd(rate: number, fromSale: boolean): number {
  const need = BUY_LIMITS.minUsd + (fromSale ? CASH.feeBufferUsd : 0);
  const r = rate > 0 ? rate : 1;
  const usd = need / (r * (1 - BUY_LIMITS.slippageBps / 10_000));
  return Math.max(SELL_LIMITS.minUsd, Math.ceil(usd * 100 - 1e-9) / 100);
}

/**
 * Stock → stock in one batch: approve A → swap A for USDC to the user, at least `sellMinOut` → approve exactly the
 * buy's USDC → swap it for B to the user, at least the quote less 1%. The buy can't spend more than the sale is sure to
 * bring, so the router stops the batch before it would touch the user's own cash. Free shares only: no call reaches
 * the Aave spoke, so credit and backing can't move. Every call passes the allowlist with the user pinned.
 */
export function buildTradeCalls(p: {
  user: Address;
  from: ReserveAsset;
  to: ReserveAsset;
  sellQuote: SellQuote;
  buyQuote: BuyQuote;
  /** Aave's price for `from`, for the sale's floor. */
  oraclePriceUsd: number;
  nowSec?: number;
  /** Shares of `from` that come out of backing first, when the free ones don't cover the sale (planSell "any"). */
  takeOutRaw?: bigint;
  /** All of `from` that backs credit comes out: the take-out signs "all". */
  takeOutAll?: boolean;
}): Call[] {
  if (p.from.kind !== "equity" || p.to.kind !== "equity" || p.from.address === p.to.address)
    throw new Error("Not a supported trade");
  const floor = sellMinOut(p.sellQuote, p.from, p.oraclePriceUsd);
  if (p.buyQuote.amountIn > floor) throw new Error("Blocked: the buy spends more than the sale is sure to bring");
  const nowSec = p.nowSec ?? Math.floor(Date.now() / 1000);
  const out = p.takeOutRaw ?? 0n;
  if (out > p.sellQuote.amountIn) throw new Error("Takes out more than it sells");
  return assertAllowed(p.user, [
    ...(out > 0n ? buildWithdrawCalls({ user: p.user, stock: p.from, amountRaw: out, all: !!p.takeOutAll }) : []),
    ...buildSellCalls({ user: p.user, stock: p.from, quote: p.sellQuote, oraclePriceUsd: p.oraclePriceUsd, nowSec }),
    ...buildBuyCalls({ user: p.user, stock: p.to, quote: p.buyQuote, nowSec }),
  ]);
}

/** Every main-screen string of the Trade sheet. None names a protocol: "the stock’s price" is Aave's (the small print says so). */
export const TRADE_COPY = {
  title: "Trade",
  pay: "You pay",
  sell: "You sell",
  get: "You get (estimated)",
  fromMenu: "Trade from",
  toMenu: "Trade to",
  flip: "Switch what you pay and what you get",
  fromPill: (name: string) => `Trade from: ${name}`,
  toPill: (name: string) => `Trade to: ${name}`,
  cashName: "Cash",
  cashHint: (usd: number) => `Cash available: ${formatUsd(usd)}`,
  subBacks: (usd: number) => `${formatUsd(usd)} of it backs your credit`,
  subShares: (shares: number) => `${formatShares(shares)} shares`,
  subAllBacks: "All of it backs your credit",
  subTooSmall: `Under ${formatUsd(SELL_LIMITS.minUsd).replace(/\.00$/, "")} free, too small to trade`,
  subNoCash: "Not enough to trade",
  free: "free",
  toTrade: "to trade",
  aShare: (usd: number) => `${formatUsd(usd)} a share`,
  atLeast: "You get at least",
  toCash: "To your cash",
  about: (usd: number) => `about ${formatUsd(usd)}`,
  buyButton: (name: string) => `Buy ${name}`,
  sellButton: (name: string) => `Sell ${name}`,
  tradeButton: "Trade",
  closed: "Stock markets are closed. You can still trade, but the price can jump when they reopen.",
  warnBuy: (pct: string, name: string) => `You’d pay ${pct}% over the stock’s price — the market for ${name} is small.`,
  warnSale: (pct: string, name: string) =>
    `You’d get ${pct}% under the stock’s price — the market for ${name} is small.`,
  noMarket: (name: string) => `There’s no market for ${name} right now.`,
  buyPrice: (pct: string) =>
    `Too big for the market right now: you’d pay ${pct}% over the stock’s price. Try a smaller amount.`,
  salePrice: `Too big for the market right now: you’d get more than ${SELL_LIMITS.floorBps / 100}% under the stock’s price. Try a smaller amount.`,
  minBuy: `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`,
  minSale: `The smallest sale is ${formatUsd(SELL_LIMITS.minUsd).replace(/\.00$/, "")}.`,
  minTrade: (usd: number) => `The smallest trade is ${formatUsd(usd)}.`,
  cashTooLow: `You need at least ${formatUsd(BUY_LIMITS.minUsd + CASH.feeBufferUsd)} in your cash to buy.`,
  notHeld: (name: string) => `You don’t have any ${name} to trade.`,
  allBacks: (name: string) => `All of your ${name} backs your credit.`,
  pastLine: SELL_BLOCKED["past-line"].replace("sell", "trade").replace("sell", "trade"),
  overCash: (usd: number) => `That’s more than your cash (${formatUsd(usd)}).`,
  feeBuffer: `Leave ${formatUsd(CASH.feeBufferUsd)} for the network fee.`,
  notFree: "That’s more than your free shares.",
  feeUnsupported: "Your account can’t pay network fees in USDC on Base right now, so this trade can’t go through.",
  swapFallback:
    "This trade would fail right now — a price may have moved or a stock may be paused. Try again in a moment.",
  failedOnChain: "The trade didn’t go through on Base. Nothing moved except any network fee.",
  sold: (shares: string, name: string) => `Sold ${shares} ${name}`,
  soldBody: "What the sale paid is in your cash.",
  emptyTitle: "Nothing to trade yet",
  emptyCash: "Top up your cash to buy stocks.",
  emptyBacks: "What you hold backs your credit. Top up your cash to trade.",
  topUp: "Top up",
} as const;

/** A row in a picker: the asset, its name, the line under it and the right column, and why it can't be picked. */
export type AssetOption = {
  asset: TradeAsset;
  name: string;
  sub?: string;
  right?: string;
  rightSub?: string;
  disabled: boolean;
};
type FromOption = AssetOption & { freeUsd: number; backsUsd: number; why?: "no-cash" | "all-backs" | "too-small" };
type ToOption = AssetOption & { priceUsd?: number; ownedUsd: number };

/**
 * "Trade from": Cash, then each stock held. A stock trades only its free shares, $1 or more of them; one whose shares
 * all back credit, or with less than $1 free, shows why and can't be picked. Stocks not held aren't listed. Cash first,
 * then what can be picked by free value, then the rest.
 */
export function fromOptions(data: Pick<TradeData, "holdings" | "cash" | "cashUsd">): FromOption[] {
  const cashOk = maxSpendRaw(data.cash) >= MIN_BUY_RAW;
  const cash: FromOption = {
    asset: "cash",
    name: TRADE_COPY.cashName,
    sub: cashOk ? undefined : TRADE_COPY.subNoCash,
    // What MAX takes, as the stock rows say: the cash less the network-fee buffer (CASH.feeBufferUsd), to the cent.
    right: formatUsd(maxUsdOf("cash", data)),
    rightSub: cashOk ? TRADE_COPY.toTrade : undefined,
    freeUsd: data.cashUsd,
    backsUsd: 0,
    disabled: !cashOk,
    why: cashOk ? undefined : "no-cash",
  };
  const stocks = data.holdings.filter(held).map((h): FromOption => {
    const why =
      sellable(h, data) === 0n
        ? ("all-backs" as const)
        : maxUsdOf(h.symbol, data) < SELL_LIMITS.minUsd
          ? ("too-small" as const)
          : undefined;
    const sub =
      why === "all-backs"
        ? TRADE_COPY.subAllBacks
        : why === "too-small"
          ? TRADE_COPY.subTooSmall
          : h.backingRaw > 0n
            ? TRADE_COPY.subBacks(h.backingUsd)
            : TRADE_COPY.subShares(h.freeShares);
    return {
      asset: h.symbol,
      name: h.name,
      sub,
      // To the cent, rounded down: what MAX takes and the From card says is free.
      right: formatUsd(maxUsdOf(h.symbol, data)),
      rightSub: TRADE_COPY.free,
      freeUsd: h.freeUsd,
      backsUsd: h.backingUsd,
      disabled: !!why,
      why,
    };
  });
  const inOrder = (a: FromOption, b: FromOption) => stockRank(a.asset) - stockRank(b.asset);
  const pickable = stocks.filter((s) => !s.disabled).sort(inOrder);
  const rest = stocks.filter((s) => s.disabled).sort(inOrder);
  return [cash, ...pickable, ...rest];
}

/** "Trade to": Cash, then the stocks held, then the others, each in Home's order with Aave's price a share. */
export function toOptions(data: Pick<TradeData, "holdings" | "cashUsd">): ToOption[] {
  const cash: ToOption = {
    asset: "cash",
    name: TRADE_COPY.cashName,
    right: formatUsd(data.cashUsd),
    ownedUsd: data.cashUsd,
    disabled: false,
  };
  const row = (h: TradeHolding): ToOption => ({
    asset: h.symbol,
    name: h.name,
    sub: TRADE_COPY.aShare(h.priceUsd),
    right: held(h) ? formatUsd(valueOf(h)) : undefined,
    priceUsd: h.priceUsd,
    ownedUsd: held(h) ? valueOf(h) : 0,
    disabled: false,
  });
  const mine = data.holdings.filter(held).sort(byStockOrder);
  const others = data.holdings.filter((h) => !held(h)).sort(byStockOrder);
  return [cash, ...mine.map(row), ...others.map(row)];
}

/**
 * What the sheet opens on. From: Cash when it can buy $1, else the stock with the most free value; null when nothing
 * can be traded (the empty state). To: the biggest holding (or the first stock A to Z) from Cash, Cash from a stock.
 * A seed wins when it can be traded.
 */
export function defaultLegs(
  data: Pick<TradeData, "holdings" | "cash" | "cashUsd">,
  seed: { from?: TradeAsset; to?: TradeAsset } = {},
): { from: TradeAsset; to: TradeAsset } | null {
  const pickable = fromOptions(data).filter((o) => !o.disabled);
  if (!pickable.length) return null;
  // The cash when it can pay, else the stock with the most free value (the list itself is in Home's order).
  const lead = pickable[0].asset === "cash" ? "cash" : [...pickable].sort((a, b) => b.freeUsd - a.freeUsd)[0].asset;
  const from = seed.from && pickable.some((o) => o.asset === seed.from) ? seed.from : lead;
  if (seed.to && routeOf(from, seed.to)) return { from, to: seed.to };
  if (from !== "cash") return { from, to: "cash" };
  const biggest =
    data.holdings.filter(held).sort((a, b) => valueOf(b) - valueOf(a))[0] ?? [...data.holdings].sort(byStockOrder)[0];
  const to = biggest?.symbol ?? EQUITIES[0].symbol;
  return { from, to };
}

/** The empty state's line: whether the stocks there are all back credit. */
export const emptyLine = (data: Pick<TradeData, "holdings">) =>
  data.holdings.some((h) => h.backingRaw > 0n) ? TRADE_COPY.emptyBacks : TRADE_COPY.emptyCash;

/** The most the From card takes, in dollars, rounded down to the cent: the cash less the fee buffer, or the free shares. */
export function maxUsdOf(from: TradeAsset, data: Pick<TradeData, "holdings" | "cash">): number {
  if (from === "cash") return Number(maxSpendRaw(data.cash) / 10_000n) / 100;
  const stock = stockOf(from);
  const h = data.holdings.find((x) => x.symbol === from);
  return stock && h ? Number(sellableCents(h, stock, data)) / 100 : 0;
}

/** The position fields Up to $X reads, or null when the caller has none (no credit read yet). */
function positionOf(data: object): Pick<SellPosition, "totalBackingUsd" | "avgCf" | "debtUsd"> | null {
  const d = data as Partial<SellPosition>;
  return d.totalBackingUsd === undefined || d.avgCf === undefined || d.debtUsd === undefined
    ? null
    : { totalBackingUsd: d.totalBackingUsd, avgCf: d.avgCf, debtUsd: d.debtUsd };
}

/**
 * NYM's clamp: an amount over the most the From card takes snaps to it, and a stock's then sells every free share. A
 * stock's amount at exactly that most (its free value to the cent) sells every free share too, so no dust under a cent
 * is left that could never trade. Nothing changes when there's nothing to take.
 */
export function clampAmount(
  from: TradeAsset,
  data: Pick<TradeData, "holdings" | "cash">,
  amount: string,
): { amount: string; all: boolean } {
  const max = maxUsdOf(from, data);
  const n = Number(amount) || 0;
  if (max > 0 && n > max) return { amount: String(max), all: from !== "cash" };
  return { amount, all: max > 0 && n === max && from !== "cash" };
}

/** The sheet's two legs: what you trade from, and what you get. */
type TradeLegs = { from: TradeAsset; to: TradeAsset };
/** The Trade sheet's own state: the legs (null with nothing to trade), the From card's dollars, and whether it sells every free share. */
export type TradeForm = { legs: TradeLegs | null; amount: string; all: boolean };
export type TradeAction =
  | { type: "pick"; which: "from" | "to"; asset: TradeAsset }
  | { type: "flip" }
  | { type: "amount"; value: string }
  | { type: "max" };

/**
 * One step of the Trade sheet's legs and amount (the sheet holds no rules of its own). Typed dollars are clamped
 * (`clampAmount`). MAX takes the most the From card takes; on a stock it sells every free share, and keeps doing so
 * whatever To becomes while that stock stays the From. New legs keep the dollars, clamped to what the new From takes.
 * Picking the other leg's asset flips the legs; a pick that makes no trade (cash to cash) changes nothing.
 */
export function tradeForm(
  state: TradeForm,
  action: TradeAction,
  data: Pick<TradeData, "holdings" | "cash">,
): TradeForm {
  const { legs } = state;
  if (!legs) return action.type === "amount" ? { ...state, amount: action.value, all: false } : state;
  if (action.type === "amount") return { legs, ...clampAmount(legs.from, data, action.value) };
  if (action.type === "max") return { legs, amount: String(maxUsdOf(legs.from, data)), all: legs.from !== "cash" };
  const flipped = { from: legs.to, to: legs.from };
  let next: TradeLegs = flipped;
  if (action.type === "pick" && action.asset !== (action.which === "from" ? legs.to : legs.from)) {
    next = action.which === "from" ? { from: action.asset, to: legs.to } : { from: legs.from, to: action.asset };
    if (!routeOf(next.from, next.to)) return state;
  }
  // The same stock still sells: MAX's every free share holds.
  if (next.from === legs.from && state.all) return { legs: next, amount: state.amount, all: true };
  return { legs: next, ...clampAmount(next.from, data, state.amount) };
}

const usdRawOf = (amount: string): bigint => {
  const clean = amount.trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return 0n;
  const [int, frac = ""] = clean.split(".");
  return parseUnits(`${int || "0"}.${frac.slice(0, USDC.decimals) || "0"}`, USDC.decimals);
};

/** What the From card's amount means for each route: the dollars, and the shares a sale sells. */
export function tradeAmount(p: {
  from: TradeAsset;
  to: TradeAsset;
  amount: string;
  all: boolean;
  data: Pick<TradeData, "holdings" | "cash">;
}) {
  const route = routeOf(p.from, p.to);
  const fromStock = stockOf(p.from);
  const toStock = stockOf(p.to);
  const fromHolding = p.data.holdings.find((h) => h.symbol === fromStock?.symbol);
  const toHolding = p.data.holdings.find((h) => h.symbol === toStock?.symbol);
  const usdRaw = usdRawOf(p.amount);
  const maxUsd = maxUsdOf(p.from, p.data);
  // MAX sells every share it can, to the last unit, while the dollars still say all of it (more shares arriving after MAX
  // aren't sold unseen); so does an amount that would leave less than NO_DUST_USD (ruling 7b). Other typed dollars
  // become shares at Aave's price, rounded down.
  const typed = toUsd(usdRaw);
  const sellAll =
    !!fromStock &&
    maxUsd > 0 &&
    typed > 0 &&
    (p.all ? typed >= maxUsd : typed <= maxUsd + 1e-9 && maxUsd - typed < NO_DUST_USD);
  const sharesRaw =
    fromStock && fromHolding
      ? sellAll
        ? sellable(fromHolding, p.data)
        : sharesForUsdRaw(usdRaw, fromHolding.priceRaw, fromStock.decimals)
      : 0n;
  return {
    route,
    fromStock,
    toStock,
    fromHolding,
    toHolding,
    maxUsd,
    usdRaw,
    amountUsd: toUsd(usdRaw),
    sharesRaw,
  };
}

/** A quote as the sheet's queries hold it: `data` null when no pool can fill it. */
export type QuoteState<Q> = { data?: Q | null; isFetching: boolean; isSuccess: boolean };

export type Leg<Q> =
  | { state: "idle" }
  | { state: "quoting" }
  | { state: "none" }
  | { state: "ready"; quote: Q; fetching: boolean };
/** One leg's quote for `amountIn`: none to read, waiting, no pool can fill it, or this amount's quote. */
export function legOf<Q extends BuyQuote>(q: QuoteState<Q> | undefined, amountIn: bigint): Leg<Q> {
  if (amountIn <= 0n || !q) return { state: amountIn <= 0n ? "idle" : "quoting" };
  if (q.data && q.data.amountIn === amountIn) return { state: "ready", quote: q.data, fetching: q.isFetching };
  if (q.data === null && q.isSuccess && !q.isFetching) return { state: "none" };
  return { state: "quoting" };
}

type YouGet =
  | { kind: "stock"; symbol: string; shares: number | null; priceUsd: number }
  | { kind: "cash"; usd: number | null };

const pct = (f: number) => (f * 100).toFixed(1);

/** The words for a free-shares sale's block, in the Trade sheet's own terms. */
export function saleBlockText(block: SellBlock, swap: boolean, minTradeUsd: number): string {
  if (block === "too-small") return swap ? TRADE_COPY.minTrade(minTradeUsd) : TRADE_COPY.minSale;
  if (block === "price") return TRADE_COPY.salePrice;
  if (block === "past-line") return TRADE_COPY.pastLine;
  if (block === "paused") return SELL_BLOCKED.paused;
  return TRADE_COPY.notFree;
}

/**
 * Everything the Trade sheet shows, from the legs, the amount, the account and the quotes the sheet read: the From
 * card's label, hint and MAX, what you get and at what price, the summary rows, the line that says why it can't go
 * ahead (or what to look out for), the button and whether it's ready. For a swap, `buyInRaw` is what the buy's quote
 * must be read for (the sale's floor, less the fee buffer when the sale pays the fee).
 */
export function planTrade(p: {
  from: TradeAsset;
  to: TradeAsset;
  amount: string;
  all: boolean;
  data: TradeData;
  /** The buy's quote: for the typed dollars (buy), or for `buyInRaw` (swap). */
  buy?: QuoteState<BuyQuote>;
  /** The sale's quote, for `sharesRaw` (sell, swap). */
  sell?: QuoteState<SellQuote>;
  now?: Date;
}) {
  const a = tradeAmount(p);
  const { route, fromStock, toStock, fromHolding, toHolding, usdRaw, amountUsd, sharesRaw, maxUsd } = a;
  const { data } = p;
  const selling = route === "sell" || route === "swap";
  const buying = route === "buy" || route === "swap";
  const fromSale = feeFromSale(data.cash);

  const sellLeg = selling ? legOf(p.sell, sharesRaw) : ({ state: "idle" } as const);
  const sellQuote = sellLeg.state === "ready" ? sellLeg.quote : null;
  const sellPlan =
    sellQuote && fromStock && fromHolding
      ? planSell({
          from: "any",
          stock: fromStock,
          holding: fromHolding,
          cf: fromHolding.cf ?? 0,
          position: data,
          quote: sellQuote,
          now: p.now,
        })
      : null;
  const buyInRaw =
    route === "buy" ? usdRaw : route === "swap" && sellPlan ? swapBuyInRaw(sellPlan.minOutRaw, data.cash) : 0n;
  const buyLeg = buying ? legOf(p.buy, buyInRaw) : ({ state: "idle" } as const);
  const buyQuote = buyLeg.state === "ready" ? buyLeg.quote : null;
  const toPrice = toHolding?.priceUsd ?? 0;
  const buyEcon = buyQuote && toStock ? quoteEconomics(buyQuote, toStock, toPrice) : null;
  const sellEcon =
    sellQuote && fromStock && fromHolding ? sellEconomics(sellQuote, fromStock, fromHolding.priceUsd) : null;
  const minTradeUsd = swapMinUsd(sellPlan ? 1 - sellPlan.discount : 1, fromSale);

  // Why it can't go ahead: first what the From asset allows, at any amount, then the amount, then the markets.
  let blocker: string | null = null;
  if (route === "buy" && maxSpendRaw(data.cash) < MIN_BUY_RAW) blocker = TRADE_COPY.cashTooLow;
  else if (selling && fromHolding && !held(fromHolding)) blocker = TRADE_COPY.notHeld(fromHolding.name);
  else if (selling && fromHolding && sellable(fromHolding, data) === 0n)
    blocker = TRADE_COPY.allBacks(fromHolding.name);
  else if (amountUsd > 0 && route) {
    if (route === "buy" && amountUsd > maxUsd)
      blocker = amountUsd > data.cashUsd ? TRADE_COPY.overCash(data.cashUsd) : TRADE_COPY.feeBuffer;
    else if (selling && fromHolding && sharesRaw > sellable(fromHolding, data))
      blocker = fromHolding.backingRaw > 0n && fromHolding.cf ? TRADE_COPY.pastLine : TRADE_COPY.notFree;
    else if (route === "buy" && amountUsd < BUY_LIMITS.minUsd) blocker = TRADE_COPY.minBuy;
    else if (route === "sell" && amountUsd < SELL_LIMITS.minUsd) blocker = TRADE_COPY.minSale;
    else if (route === "swap" && amountUsd < SELL_LIMITS.minUsd) blocker = TRADE_COPY.minTrade(minTradeUsd);
    else if (selling && sellLeg.state === "none") blocker = TRADE_COPY.noMarket(fromStock!.name);
    else if (sellPlan?.block) blocker = saleBlockText(sellPlan.block, route === "swap", minTradeUsd);
    else if (route === "swap" && sellPlan && buyInRaw < MIN_BUY_RAW) blocker = TRADE_COPY.minTrade(minTradeUsd);
    else if (buying && buyLeg.state === "none") blocker = TRADE_COPY.noMarket(toStock!.name);
    else if (buyEcon && buyEcon.premium > BUY_LIMITS.blockPremium) blocker = TRADE_COPY.buyPrice(pct(buyEcon.premium));
  }
  // Waiting on a quote: a swap reads the sale's first, then the buy's for the sale's floor.
  const quoting =
    !blocker && amountUsd > 0 && ((selling && sellLeg.state === "quoting") || (buying && buyLeg.state === "quoting"));
  const warn =
    blocker || amountUsd <= 0
      ? null
      : sellPlan?.warn
        ? TRADE_COPY.warnSale(pct(sellPlan.discount), fromStock!.name)
        : buyEcon && buyEcon.premium > BUY_LIMITS.warnPremium
          ? TRADE_COPY.warnBuy(pct(buyEcon.premium), toStock!.name)
          : null;
  const closed = !blocker && !warn && amountUsd > 0 && !!route && !marketState(p.now).open;
  const note = blocker
    ? { text: blocker, tone: "act" as const }
    : warn
      ? { text: warn, tone: "watch" as const }
      : closed
        ? { text: TRADE_COPY.closed, tone: "watch" as const }
        : null;

  const legsReady =
    route === "buy"
      ? buyLeg.state === "ready" && !buyLeg.fetching
      : route === "sell"
        ? sellLeg.state === "ready" && !sellLeg.fetching && !!sellPlan
        : route === "swap"
          ? sellLeg.state === "ready" && !sellLeg.fetching && !!sellPlan && buyLeg.state === "ready" && !buyLeg.fetching
          : false;
  const ready = !!route && amountUsd > 0 && !blocker && legsReady;

  // What you get: shares of the To stock from the buy's quote, or the sale's dollars; "…" while quoting.
  const youGet: YouGet = toStock
    ? {
        kind: "stock",
        symbol: toStock.symbol,
        shares: buyQuote ? Number(buyQuote.amountOut) / 10 ** toStock.decimals : quoting ? null : 0,
        priceUsd: buyEcon ? buyEcon.price : toPrice,
      }
    : {
        kind: "cash",
        usd: sellEcon ? sellEcon.usd : quoting ? null : 0,
      };

  const shown = amountUsd > 0 && !blocker;
  const val = (v: () => string) => (!shown ? "—" : quoting ? "…" : v());
  const minShares = () =>
    `${(Number(minOut(buyQuote!.amountOut)) / 10 ** toStock!.decimals).toFixed(4)} ${tickerOf(toStock!.symbol)}`;
  const rows: { label: string; value: string }[] =
    route === "buy"
      ? [{ label: TRADE_COPY.atLeast, value: val(() => (buyQuote ? minShares() : "—")) }]
      : route === "sell"
        ? [{ label: TRADE_COPY.atLeast, value: val(() => (sellPlan ? formatUsd(toUsd(sellPlan.minOutRaw)) : "—")) }]
        : route === "swap"
          ? [
              { label: TRADE_COPY.atLeast, value: val(() => (buyQuote ? minShares() : "—")) },
              {
                label: TRADE_COPY.toCash,
                value: val(() =>
                  sellQuote && buyQuote ? TRADE_COPY.about(toUsd(sellQuote.amountOut - buyQuote.amountIn)) : "—",
                ),
              },
            ]
          : [];

  const fromCash = p.from === "cash";
  const hint: AmountHint = fromCash
    ? TRADE_COPY.cashHint(data.cashUsd)
    : {
        shares: fromStock && fromHolding ? rawToShares(sharesRaw, fromHolding.multiplier, fromStock.decimals) : 0,
        priceUsd: fromHolding?.priceUsd ?? 0,
        upToUsd: maxUsd,
      };

  return {
    route,
    fromStock,
    toStock,
    fromHolding,
    toHolding,
    fromLabel: fromCash ? TRADE_COPY.pay : TRADE_COPY.sell,
    hint,
    maxUsd,
    amountUsd,
    usdRaw,
    sharesRaw,
    sellQuote,
    sellPlan,
    buyQuote,
    buyInRaw,
    feeFromSale: fromSale,
    quoting,
    youGet,
    rows,
    blocker,
    warn,
    closed,
    note,
    button:
      route === "buy"
        ? TRADE_COPY.buyButton(toStock!.name)
        : route === "sell"
          ? TRADE_COPY.sellButton(fromStock!.name)
          : TRADE_COPY.tradeButton,
    ready,
  };
}

/** What Activity shows while a stock → stock trade confirms, in the order the receipt reads (the buy, then the sale). */
export function tradeActivity(p: {
  from: ReserveAsset;
  to: ReserveAsset;
  plan: SellPlan;
  buyQuote: BuyQuote;
}): ActivityItem[] {
  return [
    {
      kind: "buy",
      symbol: p.to.symbol,
      amount: Number(p.buyQuote.amountOut) / 10 ** p.to.decimals,
      paidUsd: toUsd(p.buyQuote.amountIn),
    },
    {
      kind: "sell",
      symbol: p.from.symbol,
      amount: Number(p.plan.sharesRaw) / 10 ** p.from.decimals,
      receivedUsd: p.plan.usd,
    },
  ];
}

/**
 * A stock → stock trade's small print (D7): every move in the batch, both floors, what stays as cash and what the
 * stocks are. It may name the venues and Aave's price, as the Buy and Sell steps' small print does.
 */
export function swapSmallPrint(p: {
  from: ReserveAsset;
  to: ReserveAsset;
  fromHolding: Pick<TradeHolding, "priceUsd" | "multiplier">;
  sellQuote: SellQuote;
  plan: SellPlan;
  buyQuote: BuyQuote;
}): string {
  const shares = formatShares(rawToShares(p.plan.sharesRaw, p.fromHolding.multiplier, p.from.decimals));
  const buyIn = formatUsd(toUsd(p.buyQuote.amountIn));
  const atLeast = (Number(minOut(p.buyQuote.amountOut)) / 10 ** p.to.decimals).toFixed(4);
  return (
    `In one go: ${takeOutWords(p.plan.takeOutRaw, p.fromHolding.multiplier, p.from)}exactly ${shares} ${tickerOf(p.from.symbol)} is approved for the ${VENUE_LABEL[p.sellQuote.venue]} router and swapped ` +
    `for at least ${formatUsd(toUsd(p.plan.minOutRaw))}, then exactly ${buyIn} is approved for the ${VENUE_LABEL[p.buyQuote.venue]} router ` +
    `and swapped for ${p.to.name}. You get at least ${atLeast} ${tickerOf(p.to.symbol)}. If either price moves more than ` +
    `${BUY_LIMITS.slippageBps / 100}%, the trade is cancelled, and ${p.from.name} never sells for more than ${SELL_LIMITS.floorBps / 100}% ` +
    `under Aave’s price (${formatUsd(p.fromHolding.priceUsd)}). What the sale brings above ${buyIn} stays in your cash. ` +
    `${p.from.name} and ${p.to.name} here are tokenized stocks. They track the share price; they are not company shares or voting rights.`
  );
}

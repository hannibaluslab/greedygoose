import { parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { fullRepayAmount } from "@/lib/aave/tx";
import { cashRaw, feeBufferRaw, maxSpendRaw, toUsd, type Cash } from "@/lib/cash";
import { formatShares, formatUsd, formatUsdTrim } from "@/lib/formatting";
import { homeStatus, statusFor, type Status } from "@/lib/risk/status";
import { freeRepayRaw, planSell, repaySaleMaxRaw, saleRepayRaw, type SellBlock, type SellPlan, type SellPosition } from "@/lib/sell";
import { BUY_LIMITS } from "@/lib/swap/buy";
import { SELL_LIMITS, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { legOf, type Leg, type QuoteState } from "@/lib/trade";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

/**
 * Repay is one choice: pay with (Adrian, 2026-10-15). The sheet says what's owed, then "Pay with": the cash, each stock
 * held free, each stock that backs the credit, in that order, every row with the status it would land in. One amount in
 * dollars (All by default, $25 and $50 as quick picks), what's owed after, who pays the network fee, one Repay button.
 * Everything the sheet shows comes from here; the sheet holds no money maths.
 *
 * - Cash repays as before (useRepayBatch: savings first through payFromCash, exact approve, allowance reset on a full repay).
 * - A free stock sells its shares to USDC and repays exactly what the sale is sure to bring (`buildFreeRepayCalls`).
 * - A backing stock is the existing repay by selling (planSell's "repay": out of backing, sold, repaid, near-limit guard).
 */

/** The holding's fields Repay reads (usePosition's Holding has them all). */
export type RepayHolding = {
  symbol: string;
  name: string;
  priceUsd: number;
  freeRaw: bigint;
  lockedRaw: bigint;
  freeUsd: number;
  lockedUsd: number;
  paused: boolean;
  multiplier: bigint;
};

/** The position's fields Repay reads (usePosition's data has them all). */
export type RepayData = SellPosition & { holdings: RepayHolding[]; cash: Cash; cashUsd: number; status: Status };

export type RepayKind = "cash" | "free" | "backing";

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

/** Every main-screen string of the Repay sheet. None names a protocol: "the stock’s price" is Aave's (the small print says so). */
export const REPAY_COPY = {
  title: "Repay",
  owe: "You owe",
  payWith: "Pay with",
  cash: "Cash",
  cashSub: (usd: number) => `${formatUsd(usd)} in your cash`,
  freeSub: (usd: number) => `${formatUsd(usd)} free`,
  backsSub: (usd: number) => `${formatUsd(usd)} backs your credit`,
  after: "after",
  safest: "Paying with cash or another stock keeps your backing, so it’s the safest.",
  amount: "Amount",
  all: "All",
  sells: (shares: string, ticker: string) => `Sells ${shares} ${ticker}`,
  sellsQuoting: "Sells …",
  oweAfter: "You owe after",
  fee: "Network fee",
  feeFromCash: "Paid from your cash",
  feeFromSale: "Paid from the sale",
  button: "Repay",
  nothingOwed: "You don’t owe anything.",
  snappedAll: "That’s everything you owe.",
  snappedCash: "That’s the most your cash can repay.",
  snappedStock: (name: string) => `That’s the most ${name} can repay right now.`,
  addMoney: "Add money",
  noCash: "Add money to your cash to repay.",
  tooLittle: (usd: number) => `You need ${formatUsd(usd)} in your cash to repay: ${formatUsd(CASH.feeBufferUsd)} of it stays for the network fee.`,
  minRepay: (usd: number) => `The smallest repay is ${formatUsd(usd).replace(/\.00$/, "")}.`,
  noMarket: (name: string) => `There’s no market for ${name} right now.`,
  price: `Too big for the market right now: the sale would get more than ${SELL_LIMITS.floorBps / 100}% under the stock’s price. Repay less.`,
  warn: (pct: string, name: string) => `You’d get ${pct}% under the stock’s price — the market for ${name} is small.`,
  closed: "Stock markets are closed. You can still sell, but the price can jump when they reopen.",
  paused: (name: string) => `${name} can’t come out of backing right now. Try again later.`,
  nearLimit: "That would take too much out of backing before the repay lands. Repay less, or pay with cash.",
  act: "That would put your credit in Act. Repay more, or pay with cash.",
  notHeld: "That’s more than you have.",
  feeUnsupported: "Your account can’t pay network fees in USDC on Base right now.",
  done: (usd: number) => `Repaid ${formatUsdTrim(usd)}`,
  doneAll: "Repaid all your credit",
} as const;

/** What a sale's floor keeps of its quote (the swap's 1% slippage). */
const SLIP = 1 - BUY_LIMITS.slippageBps / 10_000;
/**
 * A row is listed only if it can still repay $1 when its pool pays up to this much under Aave's price, so a stock that
 * only just reaches $1 at Aave's price isn't offered and then quoted under it.
 */
const LIST_POOL_ALLOWANCE = 0.99;
/** The smallest repay: $1, or all of it when less is owed. */
export const MIN_REPAY_USD = 1;
export const minRepayUsd = (debtUsd: number) => Math.min(MIN_REPAY_USD, debtUsd);

const usdcRaw = (usd: number) => parseUnits(Math.max(0, usd).toFixed(USDC.decimals), USDC.decimals);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const tickerOf = (symbol: string) => symbol.replace(/c$/, "");
const stockOf = (symbol: string) => EQUITIES.find((e) => e.symbol === symbol);
/** Dollars to the cent: up for a full repay (what's owed is never shown as less), down otherwise. */
export const toCents = (usd: number, up: boolean) => (up ? Math.ceil(usd * 100 - 1e-6) : Math.floor(usd * 100 + 1e-6)) / 100;

/** The cash can't keep the network-fee buffer, so a sale pays the fee (as the Trade sheet's `feeFromSale`). */
const cashCantPayFee = (cash: Cash) => cashRaw(cash) < feeBufferRaw;

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
  const feeFromSale = cashCantPayFee(data.cash);
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
        feeFromSale,
        estUsd: cap(h.freeUsd * SLIP - (feeFromSale ? fee : 0)),
      },
    ];
  });
  const backing = data.holdings.flatMap((h): RepaySource[] => {
    const stock = stockOf(h.symbol);
    const cf = cfs?.[h.symbol];
    if (!stock || !cf || h.lockedRaw === 0n || h.paused) return [];
    const maxSharesRaw = repaySaleMaxRaw(h, cf, data);
    const valueUsd = (Number(maxSharesRaw) / 10 ** stock.decimals) * h.priceUsd;
    if (valueUsd < SELL_LIMITS.minUsd) return [];
    return [
      {
        id: `backing:${h.symbol}`,
        kind: "backing",
        name: h.name,
        sub: REPAY_COPY.backsSub(h.lockedUsd),
        stock,
        holding: h,
        cf,
        maxSharesRaw,
        valueUsd,
        feeFromSale: true,
        estUsd: cap(valueUsd * SLIP - fee),
      },
    ];
  });
  const byMost = (a: RepaySource, b: RepaySource) => b.estUsd - a.estUsd || b.valueUsd - a.valueUsd;
  const min = minRepayUsd(data.debtUsd);
  // A stock's estimate with its pool paying up to 1% under Aave's price (LIST_POOL_ALLOWANCE); the cash is exact.
  const canRepay = (s: RepaySource) =>
    s.kind === "cash" ? s.estUsd : cap(s.valueUsd * SLIP * LIST_POOL_ALLOWANCE - (s.feeFromSale ? fee : 0));
  return [cash, ...free.sort(byMost), ...backing.sort(byMost)].filter((s) => s.estUsd > 0 && canRepay(s) >= min - 1e-9);
}

/** The row on screen: the one picked while it's still listed, else the first (the cash when it can repay $1). */
export const pickedSource = (sources: RepaySource[], id: string | null) => sources.find((s) => s.id === id) ?? sources[0] ?? null;

/** Why nothing can repay (no row listed while something is owed): no money at all, or not enough cash. */
export function noSourceLine(data: Pick<RepayData, "cash" | "debtUsd" | "holdings">): string {
  const holdsStock = data.holdings.some((h) => h.freeRaw + h.lockedRaw > 0n);
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
export function repayMax(source: RepaySource, data: Pick<RepayData, "cash" | "debtRaw" | "debtUsd">, maxQuote?: SellQuote | null): RepayMax {
  if (source.kind === "cash") {
    const spend = maxSpendRaw(data.cash);
    return { usd: Math.min(toUsd(spend), data.debtUsd), raw: fullRepayAmount(data.debtRaw, spend), coversAll: spend >= data.debtRaw, quoting: false };
  }
  if (!maxQuote || !source.stock || !source.holding) {
    return { usd: source.estUsd, raw: usdcRaw(source.estUsd), coversAll: source.estUsd >= data.debtUsd, quoting: !maxQuote && maxQuote !== null };
  }
  const floor = sellMinOut(maxQuote, source.stock, source.holding.priceUsd);
  const raw = source.kind === "free" ? freeRepayRaw(floor, data.debtRaw, source.feeFromSale) : saleRepayRaw(floor, data.debtRaw);
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
export function statusAfter(source: RepaySource, usd: number, data: Pick<RepayData, "collateralUsd" | "avgCf" | "debtUsd" | "status">): Exclude<Status, "none"> {
  const r = Math.min(usd, source.estUsd);
  if (r <= 0) return homeStatus(data.status);
  if (r >= data.debtUsd - 0.005) return "safe";
  const weighted = data.collateralUsd * data.avgCf;
  // A backing stock takes out the shares that bring r and the fee: (r + fee) at Aave's price less the swap's 1%.
  const removed = source.kind === "backing" ? ((r + CASH.feeBufferUsd) / SLIP) * source.cf : 0;
  return homeStatus(statusFor((weighted - removed) / (data.debtUsd - r)));
}

/**
 * The sheet's own state: the row picked (null: the default), the amount typed, or All, and whether what was typed went
 * over the most and snapped back to it (`snapped`: the sheet says so in one line).
 */
export type RepayForm = { source: string | null; amount: string; all: boolean; snapped?: boolean };
export const REPAY_FORM: RepayForm = { source: null, amount: "", all: true };
export type RepayAction =
  | { type: "source"; id: string }
  | { type: "amount"; value: string; max: RepayMax }
  | { type: "chip"; usd: number; max: RepayMax }
  | { type: "all" };

/**
 * One step of the sheet's form. A new row starts on All. The amount is typed in dollars, and a quick pick fills it.
 * Dollars at the most the row repays are All; more than that (more than owed, or than the row can pay) snap back to
 * it, All, and the sheet says so in one line (NYM's clamp). So the amount is never more than owed or than the row can pay.
 */
export function repayForm(state: RepayForm, action: RepayAction): RepayForm {
  if (action.type === "source") return { source: action.id, amount: "", all: true };
  if (action.type === "all") return { source: state.source, amount: "", all: true };
  const value = action.type === "chip" ? String(action.usd) : action.value;
  const { max } = action;
  const n = Number(value) || 0;
  const most = toCents(max.usd, max.coversAll);
  // Keys typed after a snap land on the most again (the field shows it): the line stays until the amount goes under it.
  if (!max.quoting && max.usd > 0 && n >= most) {
    return n > most || (state.snapped && state.all) ? { source: state.source, amount: "", all: true, snapped: true } : { source: state.source, amount: "", all: true };
  }
  return { source: state.source, amount: value, all: false };
}

/** The quick picks: $25 and $50 while they're under the most the row repays, then All. */
export const QUICK_PICKS = [25, 50] as const;
export const quickPicks = (max: RepayMax) => QUICK_PICKS.filter((usd) => usd < max.usd);

const pct = (f: number) => (f * 100).toFixed(1);

/** A sale's block in the Repay sheet's own words. */
function blockText(block: SellBlock, source: RepaySource, min: number): string {
  if (block === "paused") return REPAY_COPY.paused(source.name);
  if (block === "near-limit") return REPAY_COPY.nearLimit;
  if (block === "act") return REPAY_COPY.act;
  if (block === "price") return REPAY_COPY.price;
  if (block === "nothing-owed") return REPAY_COPY.nothingOwed;
  if (block === "too-small") return REPAY_COPY.minRepay(min);
  return REPAY_COPY.notHeld;
}

export type RepayView = ReturnType<typeof planRepay>;

/**
 * Everything the sheet shows for the row picked and the amount on screen: the amount field's text, the shares a stock
 * sells, what it repays, what's owed after and its status, who pays the network fee, the line that says why it can't go
 * ahead (or what to look out for), and whether it's ready. A stock reads two quotes: one for all the shares it can sell
 * (`maxQuote`: All, and the floor per share), then one for the shares this amount sells (`quote`).
 */
export function planRepay(p: {
  data: RepayData;
  source: RepaySource;
  form: RepayForm;
  maxQuote?: QuoteState<SellQuote>;
  quote?: QuoteState<SellQuote>;
  now?: Date;
}) {
  const { data, source, form } = p;
  const stock = source.stock;
  const h = source.holding;
  const isStock = source.kind !== "cash" && !!stock && !!h;
  const maxLeg = isStock ? legOf(p.maxQuote, source.maxSharesRaw) : ({ state: "idle" } as const);
  const maxQuote = maxLeg.state === "ready" ? maxLeg.quote : maxLeg.state === "none" ? null : undefined;
  const max = repayMax(source, data, maxQuote);
  const min = minRepayUsd(data.debtUsd);
  const typed = Number(form.amount) || 0;
  const all = form.all || (!max.quoting && max.usd > 0 && typed >= toCents(max.usd, max.coversAll));
  const amountUsd = all ? max.usd : typed;
  const fieldText = form.all ? allText(max) : form.amount;
  // Under the smallest repay: typed, or All once the quote shows the row can't reach it.
  const tooSmall = amountUsd > 0 && amountUsd < min - 1e-9 && !(all && max.quoting);

  let sharesRaw = 0n;
  let sellPlan: SellPlan | null = null;
  let leg: Leg<SellQuote> = { state: "idle" };
  let repayRaw = 0n;
  if (source.kind === "cash") {
    repayRaw = all ? max.raw : usdcRaw(amountUsd);
  } else if (isStock && maxLeg.state === "ready" && amountUsd > 0 && !tooSmall) {
    const full = all && max.coversAll;
    sharesRaw =
      all && !max.coversAll
        ? source.maxSharesRaw
        : sharesForRepay({
            // A full repay aims at what's owed plus Aave's interest buffer, as the batch repays it.
            targetRaw: full ? fullRepayAmount(data.debtRaw, data.debtRaw * 2n + 1n) : usdcRaw(amountUsd),
            full,
            feeFromSale: source.feeFromSale,
            maxSharesRaw: source.maxSharesRaw,
            maxQuote: maxLeg.quote,
            maxFloorRaw: sellMinOut(maxLeg.quote, stock!, h!.priceUsd),
          });
    leg = legOf(p.quote, sharesRaw);
    if (leg.state === "ready") {
      sellPlan = planSell({ from: source.kind === "free" ? "free" : "repay", stock: stock!, holding: h!, cf: source.cf, position: data, quote: leg.quote, now: p.now });
      repayRaw = source.kind === "free" ? freeRepayRaw(sellPlan.minOutRaw, data.debtRaw, source.feeFromSale) : sellPlan.repayRaw;
    }
  }
  const coversAll = source.kind === "cash" ? all && max.coversAll : repayRaw > data.debtRaw;
  const repayUsd = source.kind === "cash" ? amountUsd : Math.min(toUsd(repayRaw), data.debtUsd);
  const quoting = isStock && amountUsd > 0 && !tooSmall && (maxLeg.state === "quoting" || leg.state === "quoting");

  // Why it can't go ahead: the amount, then the markets, then the sale's own stops.
  let blocker: string | null = null;
  if (tooSmall) blocker = REPAY_COPY.minRepay(min);
  else if (isStock && amountUsd > 0 && (maxLeg.state === "none" || leg.state === "none")) blocker = REPAY_COPY.noMarket(source.name);
  else if (sellPlan?.block) blocker = blockText(sellPlan.block, source, min);
  else if (isStock && sellPlan && repayRaw <= 0n) blocker = REPAY_COPY.minRepay(min);
  const warn = !blocker && sellPlan?.warn ? REPAY_COPY.warn(pct(sellPlan.discount), source.name) : null;
  const closed = !blocker && !warn && !!sellPlan?.priceMayMove;
  // Typed more than the most: it snapped back to All, and one plain line says what that most is.
  const snapped = !!form.snapped && all && !blocker && amountUsd > 0;
  const snapText = max.coversAll ? REPAY_COPY.snappedAll : source.kind === "cash" ? REPAY_COPY.snappedCash : REPAY_COPY.snappedStock(source.name);
  const note = blocker
    ? { text: blocker, tone: "act" as const }
    : warn
      ? { text: warn, tone: "watch" as const }
      : closed
        ? { text: REPAY_COPY.closed, tone: "watch" as const }
        : null;

  // What's owed after, and the status it lands in: the plan's own for a quoted sale, the estimate until then.
  const oweAfterUsd = Math.max(0, data.debtUsd - (coversAll ? data.debtUsd : repayUsd));
  const after: Exclude<Status, "none"> =
    amountUsd <= 0
      ? homeStatus(data.status)
      : coversAll
        ? "safe"
        : source.kind === "backing" && sellPlan
          ? homeStatus(sellPlan.after)
          : source.kind === "free" && sellPlan
            ? homeStatus(statusFor((data.collateralUsd * data.avgCf) / (data.debtUsd - repayUsd)))
            : statusAfter(source, amountUsd, data);

  const ready =
    amountUsd > 0 &&
    !blocker &&
    (source.kind === "cash" ? repayRaw > 0n : leg.state === "ready" && !leg.fetching && !!sellPlan && repayRaw > 0n);

  const shares = isStock && sharesRaw > 0n ? formatShares(rawToShares(sharesRaw, h!.multiplier, stock!.decimals)) : null;
  return {
    source,
    max,
    all,
    fieldText,
    amountUsd,
    /** "Sells 0.0108 MSFT" under a stock's amount; "Sells …" while quoting. */
    sharesLine: isStock && amountUsd > 0 && !tooSmall ? (shares ? REPAY_COPY.sells(shares, tickerOf(stock!.symbol)) : REPAY_COPY.sellsQuoting) : null,
    sharesRaw,
    quote: leg.state === "ready" ? leg.quote : null,
    sellPlan,
    repayRaw,
    repayUsd,
    coversAll,
    oweAfterUsd,
    after,
    /** Under the amount, after typing more than the most: "That’s everything you owe." */
    snapLine: snapped ? snapText : null,
    fee: source.feeFromSale ? REPAY_COPY.feeFromSale : REPAY_COPY.feeFromCash,
    quoting,
    blocker,
    note,
    ready,
    /** The toast once it lands. */
    done: coversAll ? REPAY_COPY.doneAll : REPAY_COPY.done(repayUsd),
  };
}

/**
 * A repay by selling's small print (D7): every move in the batch, the floor, the repay and what the stock is. It may
 * name the venue and Aave's price, as the Sell step's small print does.
 */
export function repaySmallPrint(v: Pick<RepayView, "source" | "sharesRaw" | "quote" | "sellPlan" | "repayRaw" | "coversAll">): string | null {
  const { source, quote, sellPlan } = v;
  if (source.kind === "cash" || !source.stock || !source.holding || !quote || !sellPlan) return null;
  const ticker = tickerOf(source.stock.symbol);
  const shares = formatShares(rawToShares(v.sharesRaw, source.holding.multiplier, source.stock.decimals));
  const floor = formatUsd(toUsd(sellPlan.minOutRaw));
  const repay = formatUsd(toUsd(v.repayRaw));
  const out = source.kind === "backing" ? `${shares} ${ticker} comes out of backing, ` : `${shares} ${ticker} `;
  const repaid = v.coversAll ? `everything you owe is repaid (exactly ${repay} is approved for it)` : `exactly ${repay} of it is approved and repaid`;
  return (
    `In one go: exactly ${out}is approved for the ${VENUE_LABEL[quote.venue]} router and sold for at least ${floor}, then ${repaid}. ` +
    `What the sale brings above that stays in your cash${source.feeFromSale ? `, ${formatUsd(CASH.feeBufferUsd)} of it for the network fee` : ""}. ` +
    `It never sells for more than ${SELL_LIMITS.floorBps / 100}% under Aave’s price (${formatUsd(source.holding.priceUsd)}). ` +
    `${source.stock.name} here is a tokenized stock. It tracks the share price; it is not company shares or voting rights.`
  );
}

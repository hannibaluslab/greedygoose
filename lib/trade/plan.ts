import { feeFromSale, maxSpendRaw, toUsd } from "@/lib/cash";
import { formatUsd } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { planSell } from "@/lib/sell";
import { BUY_LIMITS, minOut, quoteEconomics, type BuyQuote } from "@/lib/swap/buy";
import { SELL_LIMITS, sellEconomics, type SellQuote } from "@/lib/swap/sell";
import { rawToShares } from "@/lib/tokens/b20";
import { swapBuyInRaw, swapMinUsd } from "./calls";
import { TRADE_COPY, saleBlockText } from "./copy";
import { tickerOf } from "@/lib/tokens/registry";
import { legOf, tradeAmount } from "./form";
import { MIN_BUY_RAW, held } from "./options";
import type { AmountHint, QuoteState, TradeAsset, TradeData } from "./types";

type YouGet =
  | { kind: "stock"; symbol: string; shares: number | null; priceUsd: number }
  | { kind: "cash"; usd: number | null };

const pct = (f: number) => (f * 100).toFixed(1);

type TradeInput = {
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
};
type TradeAmount = ReturnType<typeof tradeAmount>;
type TradeQuotes = ReturnType<typeof tradeQuotes>;

const IDLE = { state: "idle" } as const;

/**
 * Each leg's quote, the sale's plan and the buy's economics. For a swap, `buyInRaw` is what the buy's quote must be
 * read for (the sale's floor, less the fee buffer when the sale pays the fee).
 */
function tradeQuotes(a: TradeAmount, p: TradeInput) {
  const { route, fromStock, toStock, fromHolding, toHolding, usdRaw, sharesRaw } = a;
  const selling = route === "sell" || route === "swap";
  const buying = route === "buy" || route === "swap";
  const sellLeg = selling ? legOf(p.sell, sharesRaw) : IDLE;
  const sellQuote = sellLeg.state === "ready" ? sellLeg.quote : null;
  const sellPlan =
    sellQuote && fromStock && fromHolding
      ? planSell({
          from: "free",
          stock: fromStock,
          holding: fromHolding,
          cf: 0,
          position: p.data,
          quote: sellQuote,
          now: p.now,
        })
      : null;
  const buyInRaw =
    route === "buy" ? usdRaw : route === "swap" && sellPlan ? swapBuyInRaw(sellPlan.minOutRaw, p.data.cash) : 0n;
  const buyLeg = buying ? legOf(p.buy, buyInRaw) : IDLE;
  const buyQuote = buyLeg.state === "ready" ? buyLeg.quote : null;
  const toPrice = toHolding?.priceUsd ?? 0;
  const buyEcon = buyQuote && toStock ? quoteEconomics(buyQuote, toStock, toPrice) : null;
  const sellEcon =
    sellQuote && fromStock && fromHolding ? sellEconomics(sellQuote, fromStock, fromHolding.priceUsd) : null;
  return { selling, buying, sellLeg, sellQuote, sellPlan, buyInRaw, buyLeg, buyQuote, toPrice, buyEcon, sellEcon };
}

/** What the From asset allows, at any amount. */
function fromBlock(a: TradeAmount, q: TradeQuotes, data: TradeData): string | null {
  if (a.route === "buy" && maxSpendRaw(data.cash) < MIN_BUY_RAW) return TRADE_COPY.cashTooLow;
  if (!q.selling || !a.fromHolding) return null;
  if (!held(a.fromHolding)) return TRADE_COPY.notHeld(a.fromHolding.name);
  if (a.fromHolding.freeRaw === 0n) return TRADE_COPY.allBacks(a.fromHolding.name);
  return null;
}

/** What the amount allows: the most the From card takes, then the smallest buy, sale or trade. */
function sizeBlock(a: TradeAmount, q: TradeQuotes, data: TradeData, minTradeUsd: number): string | null {
  const { route, amountUsd, maxUsd, fromHolding } = a;
  if (route === "buy" && amountUsd > maxUsd)
    return amountUsd > data.cashUsd ? TRADE_COPY.overCash(data.cashUsd) : TRADE_COPY.feeBuffer;
  if (q.selling && fromHolding && a.sharesRaw > fromHolding.freeRaw) return TRADE_COPY.notFree;
  if (route === "buy" && amountUsd < BUY_LIMITS.minUsd) return TRADE_COPY.minBuy;
  if (route === "sell" && amountUsd < SELL_LIMITS.minUsd) return TRADE_COPY.minSale;
  if (route === "swap" && amountUsd < SELL_LIMITS.minUsd) return TRADE_COPY.minTrade(minTradeUsd);
  return null;
}

/** What the markets allow: a pool for each leg, the sale's own block, the swap's buy, and the buy's price. */
function marketBlock(a: TradeAmount, q: TradeQuotes, minTradeUsd: number): string | null {
  const { route, fromStock, toStock } = a;
  if (q.selling && q.sellLeg.state === "none" && fromStock) return TRADE_COPY.noMarket(fromStock.name);
  if (q.sellPlan?.block) return saleBlockText(q.sellPlan.block, route === "swap", minTradeUsd);
  if (route === "swap" && q.sellPlan && q.buyInRaw < MIN_BUY_RAW) return TRADE_COPY.minTrade(minTradeUsd);
  if (q.buying && q.buyLeg.state === "none" && toStock) return TRADE_COPY.noMarket(toStock.name);
  if (q.buyEcon && q.buyEcon.premium > BUY_LIMITS.blockPremium) return TRADE_COPY.buyPrice(pct(q.buyEcon.premium));
  return null;
}

/** Why it can't go ahead: first what the From asset allows, at any amount, then the amount, then the markets. */
function tradeBlock(a: TradeAmount, q: TradeQuotes, data: TradeData, minTradeUsd: number): string | null {
  const from = fromBlock(a, q, data);
  if (from || !(a.amountUsd > 0 && a.route)) return from;
  return sizeBlock(a, q, data, minTradeUsd) ?? marketBlock(a, q, minTradeUsd);
}

/** What to look out for, once nothing blocks it: a sale or a buy far from the stock's price. */
function tradeWarn(a: TradeAmount, q: TradeQuotes): string | null {
  if (q.sellPlan?.warn && a.fromStock) return TRADE_COPY.warnSale(pct(q.sellPlan.discount), a.fromStock.name);
  if (q.buyEcon && a.toStock && q.buyEcon.premium > BUY_LIMITS.warnPremium)
    return TRADE_COPY.warnBuy(pct(q.buyEcon.premium), a.toStock.name);
  return null;
}

/** Whether every leg the route needs has its quote, not refreshing (and the sale its plan). */
function legsReady(route: TradeAmount["route"], q: TradeQuotes): boolean {
  const buyOk = q.buyLeg.state === "ready" && !q.buyLeg.fetching;
  const sellOk = q.sellLeg.state === "ready" && !q.sellLeg.fetching && !!q.sellPlan;
  if (route === "buy") return buyOk;
  if (route === "sell") return sellOk;
  return route === "swap" && sellOk && buyOk;
}

/** What you get: shares of the To stock from the buy's quote, or the sale's dollars; null ("…") while quoting. */
function youGetOf(a: TradeAmount, q: TradeQuotes, quoting: boolean): YouGet {
  const { toStock } = a;
  if (!toStock) return { kind: "cash", usd: q.sellEcon ? q.sellEcon.usd : quoting ? null : 0 };
  return {
    kind: "stock",
    symbol: toStock.symbol,
    shares: q.buyQuote ? Number(q.buyQuote.amountOut) / 10 ** toStock.decimals : quoting ? null : 0,
    priceUsd: q.buyEcon ? q.buyEcon.price : q.toPrice,
  };
}

/** The summary rows: "—" with nothing to show, "…" while quoting. */
function tradeRows(a: TradeAmount, q: TradeQuotes, shown: boolean, quoting: boolean) {
  const { buyQuote, sellQuote, sellPlan } = q;
  const { toStock } = a;
  const val = (v: () => string) => (!shown ? "—" : quoting ? "…" : v());
  const minShares =
    buyQuote && toStock
      ? `${(Number(minOut(buyQuote.amountOut)) / 10 ** toStock.decimals).toFixed(4)} ${tickerOf(toStock.symbol)}`
      : "—";
  const atLeast = { label: TRADE_COPY.atLeast, value: val(() => minShares) };
  if (a.route === "buy") return [atLeast];
  if (a.route === "sell")
    return [{ label: TRADE_COPY.atLeast, value: val(() => (sellPlan ? formatUsd(toUsd(sellPlan.minOutRaw)) : "—")) }];
  if (a.route !== "swap") return [];
  const toCash = val(() =>
    sellQuote && buyQuote ? TRADE_COPY.about(toUsd(sellQuote.amountOut - buyQuote.amountIn)) : "—",
  );
  return [atLeast, { label: TRADE_COPY.toCash, value: toCash }];
}

/** The From card's hint: the cash there is, or a stock's shares for the dollars typed and the most it can be. */
function tradeHint(a: TradeAmount, fromCash: boolean, data: TradeData): AmountHint {
  if (fromCash) return TRADE_COPY.cashHint(data.cashUsd);
  const { fromStock, fromHolding } = a;
  return {
    shares: fromStock && fromHolding ? rawToShares(a.sharesRaw, fromHolding.multiplier, fromStock.decimals) : 0,
    priceUsd: fromHolding?.priceUsd ?? 0,
    upToUsd: a.maxUsd,
  };
}

/** The button names the buy or the sale; a stock → stock trade says Trade. */
function tradeButton(a: TradeAmount): string {
  if (a.route === "buy" && a.toStock) return TRADE_COPY.buyButton;
  if (a.route === "sell" && a.fromStock) return TRADE_COPY.sellButton;
  return TRADE_COPY.tradeButton;
}

/**
 * Everything the Trade sheet shows, from the legs, the amount, the account and the quotes the sheet read: the From
 * card's label, hint and MAX, what you get and at what price, the summary rows, the line that says why it can't go
 * ahead (or what to look out for), the button and whether it's ready. For a swap, `buyInRaw` is what the buy's quote
 * must be read for (the sale's floor, less the fee buffer when the sale pays the fee).
 */
export function planTrade(p: TradeInput) {
  const a = tradeAmount(p);
  const { route, amountUsd } = a;
  const { data } = p;
  const fromSale = feeFromSale(data.cash);
  const q = tradeQuotes(a, p);
  const minTradeUsd = swapMinUsd(q.sellPlan ? 1 - q.sellPlan.discount : 1, fromSale);

  const blocker = tradeBlock(a, q, data, minTradeUsd);
  // Waiting on a quote: a swap reads the sale's first, then the buy's for the sale's floor.
  const quoting =
    !blocker &&
    amountUsd > 0 &&
    ((q.selling && q.sellLeg.state === "quoting") || (q.buying && q.buyLeg.state === "quoting"));
  const warn = blocker || amountUsd <= 0 ? null : tradeWarn(a, q);
  const closed = !blocker && !warn && amountUsd > 0 && !!route && !marketState(p.now).open;
  const note = blocker
    ? { text: blocker, tone: "act" as const }
    : warn
      ? { text: warn, tone: "watch" as const }
      : closed
        ? { text: TRADE_COPY.closed, tone: "watch" as const }
        : null;
  const fromCash = p.from === "cash";

  return {
    route,
    fromStock: a.fromStock,
    toStock: a.toStock,
    fromHolding: a.fromHolding,
    toHolding: a.toHolding,
    fromLabel: fromCash ? TRADE_COPY.pay : TRADE_COPY.sell,
    hint: tradeHint(a, fromCash, data),
    maxUsd: a.maxUsd,
    amountUsd,
    usdRaw: a.usdRaw,
    sharesRaw: a.sharesRaw,
    sellQuote: q.sellQuote,
    sellPlan: q.sellPlan,
    buyQuote: q.buyQuote,
    buyInRaw: q.buyInRaw,
    feeFromSale: fromSale,
    quoting,
    youGet: youGetOf(a, q, quoting),
    rows: tradeRows(a, q, amountUsd > 0 && !blocker, quoting),
    blocker,
    warn,
    closed,
    note,
    button: tradeButton(a),
    ready: !!route && amountUsd > 0 && !blocker && legsReady(route, q),
  };
}

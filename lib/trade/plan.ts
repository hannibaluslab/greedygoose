import { feeFromSale, maxSpendRaw, toUsd } from "@/lib/cash";
import { formatUsd } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { planSell } from "@/lib/sell";
import { BUY_LIMITS, minOut, quoteEconomics, type BuyQuote } from "@/lib/swap/buy";
import { SELL_LIMITS, sellEconomics, type SellQuote } from "@/lib/swap/sell";
import { rawToShares } from "@/lib/tokens/b20";
import { swapBuyInRaw, swapMinUsd } from "./calls";
import { TRADE_COPY, saleBlockText, tickerOf } from "./copy";
import { legOf, tradeAmount } from "./form";
import { MIN_BUY_RAW, held } from "./options";
import type { AmountHint, QuoteState, TradeAsset, TradeData } from "./types";

type YouGet =
  | { kind: "stock"; symbol: string; shares: number | null; priceUsd: number }
  | { kind: "cash"; usd: number | null };

const pct = (f: number) => (f * 100).toFixed(1);

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
          from: "free",
          stock: fromStock,
          holding: fromHolding,
          cf: 0,
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
  else if (selling && fromHolding && fromHolding.freeRaw === 0n) blocker = TRADE_COPY.allBacks(fromHolding.name);
  else if (amountUsd > 0 && route) {
    if (route === "buy" && amountUsd > maxUsd)
      blocker = amountUsd > data.cashUsd ? TRADE_COPY.overCash(data.cashUsd) : TRADE_COPY.feeBuffer;
    else if (selling && fromHolding && sharesRaw > fromHolding.freeRaw) blocker = TRADE_COPY.notFree;
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

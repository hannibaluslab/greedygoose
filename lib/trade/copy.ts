import { CASH } from "@/config/risk";
import { toUsd } from "@/lib/cash";
import { formatShares, formatUsd } from "@/lib/formatting";
import { SELL_BLOCKED, type SellBlock, type SellPlan } from "@/lib/sell";
import { BUY_LIMITS, minOut, type BuyQuote } from "@/lib/swap/buy";
import { SELL_LIMITS, type SellQuote } from "@/lib/swap/sell";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { tickerOf, type ReserveAsset } from "@/lib/tokens/registry";
import type { TradeHolding } from "./types";

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
  // What you do, not to what (Adrian, 2026-10-21): the cards above say which stock.
  buyButton: "Buy stock",
  sellButton: "Sell stock",
  tradeButton: "Trade",
  closed: "Stock markets are closed. You can still trade, but the price can jump when they reopen.",
  warnBuy: (pct: string, name: string) => `You’d pay ${pct}% over the stock’s price. The market for ${name} is small.`,
  warnSale: (pct: string, name: string) =>
    `You’d get ${pct}% under the stock’s price. The market for ${name} is small.`,
  noMarket: (name: string) => `There’s no market for ${name} right now.`,
  buyPrice: (pct: string) =>
    `Too big for the market right now. You’d pay ${pct}% over the stock’s price. Try a smaller amount.`,
  salePrice: `Too big for the market right now. You’d get more than ${SELL_LIMITS.floorBps / 100}% under the stock’s price. Try a smaller amount.`,
  minBuy: `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`,
  minSale: `Minimum sale is ${formatUsd(SELL_LIMITS.minUsd).replace(/\.00$/, "")}.`,
  minTrade: (usd: number) => `Minimum trade is ${formatUsd(usd)}.`,
  cashTooLow: `You need at least ${formatUsd(BUY_LIMITS.minUsd + CASH.feeBufferUsd)} in your cash to buy.`,
  notHeld: (name: string) => `You don’t have any ${name} to trade.`,
  allBacks: (name: string) => `All of your ${name} backs your credit.`,
  overCash: (usd: number) => `That’s more than your cash (${formatUsd(usd)}).`,
  feeBuffer: `Leave ${formatUsd(CASH.feeBufferUsd)} for the network fee.`,
  notFree: "That’s more than your free shares.",
  feeUnsupported: "Your account can’t pay network fees from your cash right now, so this trade can’t go through.",
  swapFallback:
    "This trade would fail right now. A price may have moved or a stock may be paused. Try again in a moment.",
  failedOnChain: "The trade didn’t go through on Base. Nothing moved except any network fee.",
  sold: (shares: string, name: string) => `Sold ${shares} ${name}`,
  soldBody: "What the sale paid is in your cash.",
  emptyTitle: "Nothing to trade yet",
  emptyCash: "Top up your cash to buy stocks.",
  emptyBacks: "What you hold backs your credit. Top up your cash to trade.",
  topUp: "Top up",
} as const;

/** The words for a free-shares sale's block, in the Trade sheet's own terms. */
export function saleBlockText(block: SellBlock, swap: boolean, minTradeUsd: number): string {
  if (block === "too-small") return swap ? TRADE_COPY.minTrade(minTradeUsd) : TRADE_COPY.minSale;
  if (block === "price") return TRADE_COPY.salePrice;
  if (block === "paused") return SELL_BLOCKED.paused;
  return TRADE_COPY.notFree;
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
    `In one go: exactly ${shares} ${tickerOf(p.from.symbol)} is approved for the ${VENUE_LABEL[p.sellQuote.venue]} router and swapped ` +
    `for at least ${formatUsd(toUsd(p.plan.minOutRaw))}, then exactly ${buyIn} is approved for the ${VENUE_LABEL[p.buyQuote.venue]} router ` +
    `and swapped for ${p.to.name}. You get at least ${atLeast} ${tickerOf(p.to.symbol)}. If either price moves more than ` +
    `${BUY_LIMITS.slippageBps / 100}%, the trade is cancelled, and ${p.from.name} never sells for more than ${SELL_LIMITS.floorBps / 100}% ` +
    `under Aave’s price (${formatUsd(p.fromHolding.priceUsd)}). What the sale brings above ${buyIn} stays in your cash.`
  );
}

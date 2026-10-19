import { CASH } from "@/config/risk";
import { toUsd } from "@/lib/cash";
import { formatShares, formatUsd, formatUsdTrim } from "@/lib/formatting";
import type { SellBlock } from "@/lib/sell";
import { SELL_LIMITS } from "@/lib/swap/sell";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { tickerOf, type ReserveAsset } from "@/lib/tokens/registry";
import type { RepayView } from "./plan";
import type { RepaySource } from "./sources";

/** Every main-screen string of the Repay sheet. None names a protocol: "the stock’s price" is Aave's (the small print says so). */
export const REPAY_COPY = {
  /** The sheet's title once the Repay | Free up toggle shows (something backs the credit). */
  creditTitle: "My credit",
  freeUpTab: "Free up",
  tabsLabel: "Repay or free up",
  title: "Repay",
  owe: "You owe",
  payWith: "Pay with",
  /** The picker's accessible name: what it pays with and what that row is ("Pay with: Cash, $1.36 in your cash"). */
  payWithLabel: (name: string, sub: string) => `Pay with: ${name}, ${sub}`,
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
  button: "Repay",
  nothingOwed: "You don’t owe anything.",
  snappedAll: "That’s everything you owe.",
  snappedCash: "That’s the most your cash can repay.",
  snappedStock: (name: string) => `That’s the most ${name} can repay right now.`,
  addMoney: "Top up",
  noCash: "Top up your cash to repay.",
  tooLittle: (usd: number) =>
    `You need ${formatUsd(usd)} in your cash to repay. ${formatUsd(CASH.feeBufferUsd)} of it stays for the network fee.`,
  minRepay: (usd: number) => `Minimum repay is ${formatUsd(usd).replace(/\.00$/, "")}.`,
  noMarket: (name: string) => `There’s no market for ${name} right now.`,
  price: `Too big for the market right now. The sale would get more than ${SELL_LIMITS.floorBps / 100}% under the stock’s price. Repay less.`,
  warn: (pct: string, name: string) => `You’d get ${pct}% under the stock’s price. The market for ${name} is small.`,
  closed: "Stock markets are closed. You can still sell, but the price can jump when they reopen.",
  paused: (name: string) => `${name} can’t come out of backing right now. Try again later.`,
  nearLimit: "That would take too much out of backing before the repay lands. Repay less, or pay with cash.",
  act: "That would put your credit in Act. Repay more, or pay with cash.",
  notHeld: "That’s more than you have.",
  feeUnsupported: "Your account can’t pay network fees from your cash right now.",
  done: (usd: number) => `Repaid ${formatUsdTrim(usd)}`,
  doneAll: "Repaid all your credit",
} as const;

/** A sale's block in the Repay sheet's own words. */
export function blockText(block: SellBlock, source: RepaySource, min: number): string {
  if (block === "paused") return REPAY_COPY.paused(source.name);
  if (block === "near-limit") return REPAY_COPY.nearLimit;
  if (block === "act") return REPAY_COPY.act;
  if (block === "price") return REPAY_COPY.price;
  if (block === "nothing-owed") return REPAY_COPY.nothingOwed;
  if (block === "too-small") return REPAY_COPY.minRepay(min);
  return REPAY_COPY.notHeld;
}

/**
 * A repay by selling's small print (D7): every move in the batch, the floor and the repay. It may
 * name the venue and Aave's price, as the Sell step's small print does.
 */
export function repaySmallPrint(
  v: Pick<RepayView, "source" | "sharesRaw" | "quote" | "sellPlan" | "repayRaw" | "coversAll">,
): string | null {
  const { source, quote, sellPlan } = v;
  if (source.kind === "cash" || !source.stock || !source.holding || !quote || !sellPlan) return null;
  const ticker = tickerOf(source.stock.symbol);
  const shares = formatShares(rawToShares(v.sharesRaw, source.holding.multiplier, source.stock.decimals));
  const floor = formatUsd(toUsd(sellPlan.minOutRaw));
  const repay = formatUsd(toUsd(v.repayRaw));
  const out = source.kind === "backing" ? `${shares} ${ticker} comes out of backing, ` : `${shares} ${ticker} `;
  const repaid = v.coversAll
    ? `everything you owe is repaid (exactly ${repay} is approved for it)`
    : `exactly ${repay} of it is approved and repaid`;
  return (
    `In one go: exactly ${out}is approved for the ${VENUE_LABEL[quote.venue]} router and sold for at least ${floor}, then ${repaid}. ` +
    `What the sale brings above that stays in your cash${source.feeFromSale ? `, ${formatUsd(CASH.feeBufferUsd)} of it for the network fee` : ""}. ` +
    `It never sells for more than ${SELL_LIMITS.floorBps / 100}% under Aave’s price (${formatUsd(source.holding.priceUsd)}).`
  );
}

/** A stock the Repay sheet frees up, as its small print names it. */
type FreedOut = { stock: ReserveAsset; amountRaw: bigint; multiplier: bigint };

/**
 * The Repay sheet's whole small print (D7): the repay's own moves (the sale, or the cash), then each stock that comes
 * out of backing, after the repay, in the same signature. Null when nothing would be signed.
 */
export function repaySheetSmallPrint(
  v: (Parameters<typeof repaySmallPrint>[0] & { amountUsd: number }) | null,
  outs: readonly FreedOut[],
): string | null {
  const sale = v ? repaySmallPrint(v) : null;
  const freed = outs.map(
    (o) => `${formatShares(rawToShares(o.amountRaw, o.multiplier, o.stock.decimals))} ${tickerOf(o.stock.symbol)}`,
  );
  if (freed.length === 0) return sale;
  const names = freed.length > 1 ? `${freed.slice(0, -1).join(", ")} and ${freed.at(-1)}` : freed[0];
  const comes = `${names} ${freed.length > 1 ? "come" : "comes"} out of backing your credit`;
  if (sale) return `${sale} Then ${comes}.`;
  const cash =
    v && v.amountUsd > 0
      ? v.coversAll
        ? "everything you owe is repaid from your cash, then "
        : `exactly ${formatUsd(toUsd(v.repayRaw))} of your cash is repaid, then `
      : "";
  return `In one go: ${cash}${comes}.`;
}

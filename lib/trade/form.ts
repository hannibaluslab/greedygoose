import { parseUnits } from "viem";
import { toUsd } from "@/lib/cash";
import { NO_DUST_USD } from "@/lib/sell";
import type { BuyQuote } from "@/lib/swap/buy";
import { USDC } from "@/lib/tokens/registry";
import { sharesForUsdRaw } from "./calls";
import { clampAmount, maxUsdOf, routeOf, stockOf } from "./options";
import type { Leg, QuoteState, TradeAsset, TradeData } from "./types";

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
        ? fromHolding.freeRaw
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

/** One leg's quote for `amountIn`: none to read, waiting, no pool can fill it, or this amount's quote. */
export function legOf<Q extends BuyQuote>(q: QuoteState<Q> | undefined, amountIn: bigint): Leg<Q> {
  if (amountIn <= 0n || !q) return { state: amountIn <= 0n ? "idle" : "quoting" };
  if (q.data && q.data.amountIn === amountIn) return { state: "ready", quote: q.data, fetching: q.isFetching };
  if (q.data === null && q.isSuccess && !q.isFetching) return { state: "none" };
  return { state: "quoting" };
}

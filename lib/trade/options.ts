import { parseUnits } from "viem";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
import { maxSpendRaw } from "@/lib/cash";
import { formatUsd } from "@/lib/formatting";
import { BUY_LIMITS } from "@/lib/swap/buy";
import { SELL_LIMITS } from "@/lib/swap/sell";
import { EQUITIES, USDC, byStockOrder, stockRank, type ReserveAsset } from "@/lib/tokens/registry";
import { TRADE_COPY } from "./copy";
import type { AssetOption, TradeAsset, TradeData, TradeHolding, TradeRoute } from "./types";

const usdcRaw = (usd: number) => parseUnits(usd.toFixed(USDC.decimals), USDC.decimals);
export const MIN_BUY_RAW = usdcRaw(BUY_LIMITS.minUsd);
export const held = (h: TradeHolding) => h.freeRaw + h.backingRaw > 0n;
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

/**
 * Cents the free shares are worth at Aave's price, rounded down: what MAX shows (Up to $X). Sell, Trade and Send move
 * free shares only; shares that back credit come back with a repay first.
 */
const freeCents = (h: TradeHolding, stock: ReserveAsset) =>
  (h.freeRaw * h.priceRaw) / 10n ** BigInt(stock.decimals + ORACLE_DECIMALS - 2);

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
      h.freeRaw === 0n
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
  return stock && h ? Number(freeCents(h, stock)) / 100 : 0;
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

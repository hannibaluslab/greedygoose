import { parseUnits } from "viem";
import { maxSpendRaw } from "@/lib/cash";
import { formatUsd } from "@/lib/formatting";
import { USDC, stockRank } from "@/lib/tokens/registry";
import { clampAmount, maxUsdOf, type TradeData } from "@/lib/trade";
import type { SellPosition } from "@/lib/sell";
import { SEND_COPY } from "./copy";

/** "cash", or one of the seven stocks' registry symbols (resolved through the registry only, `stockOf`). */
export type SendAsset = "cash" | (string & {});
/** The position's fields Send reads (usePosition's data has them all). */
export type SendData = Pick<TradeData, "holdings" | "cash" | "cashUsd"> &
  Partial<Pick<SellPosition, "totalBackingUsd" | "avgCf" | "debtUsd">>;

const held = (h: SendData["holdings"][number]) => h.freeRaw + h.backingRaw > 0n;

// ─── What ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A row in "Send from": the asset, its name, the line under it and the right column, and why it can't be picked. */
type SendOption = {
  asset: SendAsset;
  name: string;
  sub?: string;
  right?: string;
  rightSub?: string;
  disabled: boolean;
  freeUsd: number;
};

/**
 * "Send from": Cash (what MAX takes: the cash less the network-fee buffer, CASH.feeBufferUsd), then each stock held.
 * A stock sends only its free shares; one whose shares all back credit is listed, says so and can't be picked. Stocks
 * not held aren't listed. Cash first, then what can be picked by free value, then the rest.
 */
export function sendOptions(data: SendData): SendOption[] {
  const cashOk = maxSpendRaw(data.cash) > 0n;
  const cash: SendOption = {
    asset: "cash",
    name: SEND_COPY.cashName,
    sub: cashOk ? undefined : SEND_COPY.subNoCash,
    right: formatUsd(maxUsdOf("cash", data)),
    rightSub: cashOk ? SEND_COPY.toSend : undefined,
    disabled: !cashOk,
    freeUsd: data.cashUsd,
  };
  const stocks = data.holdings.filter(held).map(
    (h): SendOption => ({
      asset: h.symbol,
      name: h.name,
      sub:
        h.freeRaw === 0n
          ? SEND_COPY.subAllBacks
          : h.backingRaw > 0n
            ? SEND_COPY.subBacks(h.backingUsd)
            : SEND_COPY.subShares(h.freeShares),
      right: formatUsd(maxUsdOf(h.symbol, data)),
      rightSub: SEND_COPY.free,
      disabled: h.freeRaw === 0n,
      freeUsd: h.freeUsd,
    }),
  );
  const inOrder = (a: SendOption, b: SendOption) => stockRank(a.asset) - stockRank(b.asset);
  const pickable = stocks.filter((s) => !s.disabled).sort(inOrder);
  const rest = stocks.filter((s) => s.disabled).sort(inOrder);
  return [cash, ...pickable, ...rest];
}

/** What Send opens on: the seed when it can be sent, else Cash when it can, else the stock with the most free value; null when nothing can be sent. */
export function defaultAsset(data: SendData, seed?: SendAsset): SendAsset | null {
  const pickable = sendOptions(data).filter((o) => !o.disabled);
  if (!pickable.length) return null;
  if (seed && pickable.some((o) => o.asset === seed)) return seed;
  // The cash when it can go, else the stock with the most free value (the list itself is in Home's order).
  return pickable[0].asset === "cash" ? "cash" : [...pickable].sort((a, b) => b.freeUsd - a.freeUsd)[0].asset;
}

/** Send's own state: what is sent (null with nothing to send), the dollars typed, and whether a stock sends every free share. */
export type SendForm = { asset: SendAsset | null; amount: string; all: boolean };
export type SendAction = { type: "pick"; asset: SendAsset } | { type: "amount"; value: string } | { type: "max" };

/**
 * One step of Send's amount (the screen holds no rules of its own), as Trade's: typed dollars are clamped to the most
 * the asset takes; MAX takes that most, and on a stock sends every free share; a new asset keeps the dollars, clamped.
 */
export function sendForm(state: SendForm, action: SendAction, data: SendData): SendForm {
  if (action.type === "pick") {
    if (!sendOptions(data).some((o) => o.asset === action.asset && !o.disabled)) return state;
    return { asset: action.asset, ...clampAmount(action.asset, data, state.amount) };
  }
  if (!state.asset) return action.type === "amount" ? { ...state, amount: action.value, all: false } : state;
  if (action.type === "amount") return { asset: state.asset, ...clampAmount(state.asset, data, action.value) };
  return { asset: state.asset, amount: String(maxUsdOf(state.asset, data)), all: state.asset !== "cash" };
}

export const usdRawOf = (amount: string): bigint => {
  const clean = amount.trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return 0n;
  const [int, frac = ""] = clean.split(".");
  return parseUnits(`${int || "0"}.${frac.slice(0, USDC.decimals) || "0"}`, USDC.decimals);
};

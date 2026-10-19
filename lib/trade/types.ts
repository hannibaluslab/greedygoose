import type { Cash } from "@/lib/cash";
import type { SellPosition } from "@/lib/sell";

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
};

/** The position's fields the Trade sheet reads (usePosition's data has them all). */
export type TradeData = SellPosition & { holdings: TradeHolding[]; cash: Cash; cashUsd: number };

/**
 * The line under an amount: a sentence for cash, or for a stock (canvas boards 9–11) the dollars typed in shares at
 * Aave's price and the most it can be, Up to $X.
 */
export type AmountHint = string | { shares: number; priceUsd: number; upToUsd: number };

/** A row in a picker: the asset, its name, the line under it and the right column, and why it can't be picked. */
export type AssetOption = {
  asset: TradeAsset;
  name: string;
  sub?: string;
  right?: string;
  rightSub?: string;
  disabled: boolean;
};
/** A quote as the sheet's queries hold it: `data` null when no pool can fill it. */
export type QuoteState<Q> = { data?: Q | null; isFetching: boolean; isSuccess: boolean };

export type Leg<Q> =
  | { state: "idle" }
  | { state: "quoting" }
  | { state: "none" }
  | { state: "ready"; quote: Q; fetching: boolean };

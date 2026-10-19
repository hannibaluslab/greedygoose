import type { Log } from "viem";
import { tickerOf } from "@/lib/tokens/registry";
import { decodeActivity } from "./decode";

/** Shares of `symbol` the user's buy brought in, from its receipt; null when the receipt shows none. */
export function boughtAmount(logs: Log[], user: `0x${string}`, symbol: string): number | null {
  return decodeActivity(logs, user).find((i) => i.kind === "buy" && i.symbol === symbol)?.amount ?? null;
}

/** The toast after a buy (F1-6 "Bought 0.1120 NVDA", F2-7 "Bought 1.3500 AAPL with Credit Buy"). */
export function boughtLine(amount: number | null, symbol: string, credit = false): string {
  const ticker = tickerOf(symbol);
  return `Bought ${amount === null ? "" : `${amount.toFixed(4)} `}${ticker}${credit ? " with Credit Buy" : ""}`;
}

/** The toast after a stock → stock trade (the Trade sheet): "Traded NVDA for 0.0086 AAPL". */
export function tradedLine(amount: number | null, symbol: string, from: string): string {
  const ticker = tickerOf(symbol);
  return `Traded ${tickerOf(from)} for ${amount === null ? "" : `${amount.toFixed(4)} `}${ticker}`;
}

import { CASH } from "@/config/risk";
import { formatUsd } from "@/lib/formatting";
import type { TradeAsset } from "./types";

/*
 * Multi trade (Adrian, 2026-10-21: "bring the multi mode from NYM", in the Trade sheet): NYM's MoveSheet multi mode —
 * a list of trades, each edited in the Trade sheet's own editor ("Trade 2 of 3"), all signed together in one batch
 * (lib/tx/plans/multiTrade.ts). Each row is any trade the sheet makes: cash into a stock, a stock into cash, one stock
 * into another. JAW's sheet is the confirmation (CLAUDE.md): the list is the review, and its button signs.
 */

/** One trade in the list: the editor's legs and amount, kept as typed so a row re-quotes live while the list shows. */
export type TradeRow = { from: TradeAsset; to: TradeAsset; amount: string; all: boolean };

/** At least two (one is a plain trade), and no more than fits one batch comfortably. */
export const MULTI_MIN = 2;
export const MULTI_MAX = 5;

/** The list's words, in the Trade sheet's terms. */
export const MULTI_COPY = {
  pill: "Multi trade",
  title: "Multi trade",
  cancel: "Cancel",
  newRow: (n: number) => `New trade · #${n}`,
  rowOf: (i: number, n: number) => `Trade ${i} of ${n}`,
  eyebrow: "Trades",
  count: (n: number) => `${n} · MIN ${MULTI_MIN}`,
  sub: (n: number) => (n === 0 ? "Add trades to the list" : `${n} ${n === 1 ? "trade" : "trades"} · one signature`),
  ghost: (n: number) => `Trade ${n}`,
  add: "Add",
  full: `Up to ${MULTI_MAX} trades at once.`,
  done: "Done",
  remove: "Remove",
  button: (n: number) => (n === 0 ? "Add trades" : n < MULTI_MIN ? "Add a second trade" : `Make ${n} trades`),
  oneSignature: "One signature for every trade, one network fee.",
  waiting: "Getting prices…",
  overCash: (usd: number) => `These buys need more than your cash (${formatUsd(usd)}). Lower one.`,
  overShares: (name: string) => `That’s more ${name} than you have free, across these trades. Lower one.`,
  fee: `Keep ${formatUsd(CASH.feeBufferUsd)} in your cash for the network fee.`,
  rowBlocked: "One trade can’t go ahead. Tap it to see why.",
  done_toast: (n: number) => `${n} trades done`,
  fallback:
    "These trades would fail right now. A price may have moved or a stock may be paused. Try again in a moment.",
  failedOnChain: "The trades didn’t go through on Base. Nothing moved except any network fee.",
} as const;

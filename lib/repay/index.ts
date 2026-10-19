/**
 * Repay is one choice: pay with (Adrian, 2026-10-15). The sheet says what's owed, then "Pay with": the cash, each stock
 * held free, each stock that backs the credit, in that order, every row with the status it would land in. One amount in
 * dollars (0 to start, All in the field), what's owed after, who pays the network fee, one Repay button.
 * Everything the sheet shows comes from here; the sheet holds no money maths.
 *
 * - Cash repays as before (useRepayBatch: savings first through payFromCash, exact approve, allowance reset on a full repay).
 * - A free stock sells its shares to USDC and repays exactly what the sale is sure to bring (`buildFreeRepayCalls`).
 * - A backing stock is the existing repay by selling (planSell's "repay": out of backing, sold, repaid, near-limit guard).
 */

export * from "./copy";
export * from "./sources";
export * from "./form";
export * from "./plan";

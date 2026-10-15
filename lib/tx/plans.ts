import { buildLoanCalls, buildWithdrawCalls } from "@/lib/aave/tx";
import type { ReserveAsset } from "@/lib/tokens/registry";
import { USDC } from "@/lib/tokens/registry";
import { txKey, type TxPlan } from "./prepared";

/*
 * The plans of the writes whose screens build them from what's on screen alone (no fresh reads): pure, so their keys
 * are tested with the others' (tests/unit/tx-keys.test.ts).
 */

type Address = `0x${string}`;

export const LOAN_FALLBACK = "This would fail right now — prices may have moved. Try a little less credit, or back it with a bit more.";

/** Use credit: the stocks put in as backing and the credit taken, in one batch. Keyed by exactly those. */
export const loanPlan = (p: { user: Address; locks: { stock: ReserveAsset; raw: bigint }[]; borrowRaw: bigint }): TxPlan => {
  const locks = p.locks.filter((l) => l.raw > 0n);
  const amount = Number(p.borrowRaw) / 10 ** USDC.decimals;
  return {
    key: txKey("loan", p.user, locks.map((l) => [l.stock.symbol, l.raw]), p.borrowRaw),
    user: p.user,
    calls: () => Promise.resolve(buildLoanCalls({ user: p.user, locks, borrowRaw: p.borrowRaw })),
    fallback: LOAN_FALLBACK,
    activity: [
      ...locks.map((l) => ({ kind: "supply" as const, symbol: l.stock.symbol, amount: Number(l.raw) / 10 ** l.stock.decimals })),
      ...(p.borrowRaw > 0n ? [{ kind: "borrow" as const, symbol: "USDC", amount }] : []),
    ],
  };
};

/** Free up: a stock's shares out of backing, an exact amount or all of them. Keyed by the stock, the amount and All. */
export const withdrawPlan = (p: { user: Address; stock: ReserveAsset; amountRaw: bigint; all: boolean }): TxPlan => ({
  key: txKey("withdraw", p.user, p.stock.symbol, p.amountRaw, p.all),
  user: p.user,
  calls: () => Promise.resolve(buildWithdrawCalls(p)),
  activity: [{ kind: "withdraw", symbol: p.stock.symbol, amount: Number(p.amountRaw) / 10 ** p.stock.decimals }],
});

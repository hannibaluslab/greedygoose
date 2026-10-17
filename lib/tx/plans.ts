import { buildWithdrawCalls } from "@/lib/aave/tx";
import { FREE_UP_FLOOR } from "@/lib/freeUp";
import type { ReserveAsset } from "@/lib/tokens/registry";
import { txKey, type TxPlan } from "./prepared";

/*
 * The plans of the writes whose screens build them from what's on screen alone (no fresh reads): pure, so their keys
 * are tested with the others' (tests/unit/tx-keys.test.ts).
 */

type Address = `0x${string}`;

/**
 * Free up: a stock's shares out of backing, an exact amount or all of them. Keyed by the stock, the amount and All. Its
 * simulation reads the health on Aave after it, and one in Act stops it (FREE_UP_FLOOR).
 */
export const withdrawPlan = (p: { user: Address; stock: ReserveAsset; amountRaw: bigint; all: boolean }): TxPlan => ({
  key: txKey("withdraw", p.user, p.stock.symbol, p.amountRaw, p.all),
  user: p.user,
  calls: () => Promise.resolve(buildWithdrawCalls(p)),
  healthFloor: FREE_UP_FLOOR,
  activity: [{ kind: "withdraw", symbol: p.stock.symbol, amount: Number(p.amountRaw) / 10 ** p.stock.decimals }],
});

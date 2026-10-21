import { buildWithdrawCalls } from "@/lib/aave/tx";
import { freeUpFloor } from "@/lib/freeUpPlan";
import type { ReserveAsset } from "@/lib/tokens/registry";
import { txKey, type HealthFloor, type TxPlan } from "../prepared";
import type { Address } from "./types";

/**
 * Free up: a stock's shares out of backing, an exact amount or all of them. Keyed by the stock, the amount and All. Its
 * simulation reads the health on Aave after it, and one under the line's stop stops it (freeUpFloor; in Act by default).
 */
export const withdrawPlan = (p: {
  user: Address;
  stock: ReserveAsset;
  amountRaw: bigint;
  all: boolean;
  floor?: HealthFloor;
}): TxPlan => ({
  key: txKey("withdraw", p.user, p.stock.symbol, p.amountRaw, p.all),
  user: p.user,
  calls: () => Promise.resolve(buildWithdrawCalls(p)),
  healthFloor: p.floor ?? freeUpFloor(),
  activity: [{ kind: "withdraw", symbol: p.stock.symbol, amount: Number(p.amountRaw) / 10 ** p.stock.decimals }],
});

/** A stock to take out of backing in a repay's batch (planFreeUp's `frees`, with its asset). */
export type TakeOut = { stock: ReserveAsset; amountRaw: bigint; all: boolean };

const takeOutCalls = (user: Address, outs: readonly TakeOut[]) =>
  outs.flatMap((o) => buildWithdrawCalls({ user, stock: o.stock, amountRaw: o.amountRaw, all: o.all }));

const takeOutActivity = (outs: readonly TakeOut[]) =>
  outs.map((o) => ({
    kind: "withdraw" as const,
    symbol: o.stock.symbol,
    amount: Number(o.amountRaw) / 10 ** o.stock.decimals,
  }));

/**
 * Repay and free up in one signature (canvas boards 3–7): the repay's own batch, whatever pays it (cash, a free stock,
 * a stock that backs credit), then each stock taken out. The repay goes first, so Aave checks each take-out against
 * what's owed after it. Keyed by the repay's key and every take-out; its simulation reads the health on Aave after the
 * whole batch, and one under the line's stop stops it (freeUpFloor). With no take-outs it is the repay's plan unchanged.
 */
export function withTakeOuts(plan: TxPlan, outs: readonly TakeOut[], floor: HealthFloor = freeUpFloor()): TxPlan {
  if (outs.length === 0) return plan;
  const repay = plan.calls;
  return {
    ...plan,
    key: txKey(
      plan.key,
      "take-out",
      outs.map((o) => [o.stock.symbol, o.amountRaw, o.all]),
    ),
    calls: async () => [...(typeof repay === "function" ? await repay() : repay), ...takeOutCalls(plan.user, outs)],
    healthFloor: floor,
    activity: [...(plan.activity ?? []), ...takeOutActivity(outs)],
  };
}

/** Free up with nothing repaid (canvas board 6): only the take-outs, held to the same line. */
export const takeOutPlan = (user: Address, outs: readonly TakeOut[], floor: HealthFloor = freeUpFloor()): TxPlan => ({
  key: txKey(
    "take-out",
    user,
    outs.map((o) => [o.stock.symbol, o.amountRaw, o.all]),
  ),
  user,
  calls: () => Promise.resolve(takeOutCalls(user, outs)),
  healthFloor: floor,
  activity: takeOutActivity(outs),
});

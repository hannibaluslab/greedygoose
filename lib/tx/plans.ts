import { buildWithdrawCalls, type Call } from "@/lib/aave/tx";
import { freeRepayActivity, freeRepayRaw, type SellPlan } from "@/lib/sell";
import { quoteKey } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { FREE_UP_FLOOR } from "@/lib/freeUpPlan";
import type { ReserveAsset } from "@/lib/tokens/registry";
import { txKey, type TxPlan } from "./prepared";

/*
 * The plans of the writes (useTx): what each signs and how it is keyed, pure, so their keys are tested with the others'
 * (tests/unit/tx-keys.test.ts). Some screens build their batch from what's on screen alone; the others pass the batch
 * their hook builds from fresh reads (`Batch`).
 */

type Address = `0x${string}`;
/** A hook's batch builder, run from fresh reads while the screen is idle (useTx). */
type Batch<I> = (p: I) => Promise<Call[]>;

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
 * whole batch, and one in Act stops it (FREE_UP_FLOOR). With no take-outs it is the repay's plan unchanged.
 */
export function withTakeOuts(plan: TxPlan, outs: readonly TakeOut[]): TxPlan {
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
    healthFloor: FREE_UP_FLOOR,
    activity: [...(plan.activity ?? []), ...takeOutActivity(outs)],
  };
}

/** Free up with nothing repaid (canvas board 6): only the take-outs, held to the same line. */
export const takeOutPlan = (user: Address, outs: readonly TakeOut[]): TxPlan => ({
  key: txKey(
    "take-out",
    user,
    outs.map((o) => [o.stock.symbol, o.amountRaw, o.all]),
  ),
  user,
  calls: () => Promise.resolve(takeOutCalls(user, outs)),
  healthFloor: FREE_UP_FLOOR,
  activity: takeOutActivity(outs),
});

/** What Repay would sign: a chip's exact amount, or All (every cent owed when the cash covers it, else all the cash). */
export type RepayInput = {
  user: `0x${string}`;
  /** All, or a chip. */
  all: boolean;
  /** All and the cash covers what's owed: it repays everything, whatever the interest added since. */
  coversAll: boolean;
  /** The dollars on screen. */
  amount: number;
  /** A chip's exact amount, or All's from the position on screen (all the cash, when it doesn't cover what's owed). */
  amountRaw: bigint;
};

/**
 * What Repay signs (useTx), keyed by what shapes its batch: a chip by its exact amount; All by whether it covers
 * what's owed, and, when it doesn't, by the dollars on screen to the cent (the cash it spends), so a batch for other
 * cash is never signed.
 */
export const repayPlan = (p: RepayInput, batch: Batch<RepayInput>): TxPlan => ({
  key: p.all
    ? txKey("repay", p.user, "all", p.coversAll ? "full" : Math.round(p.amount * 100))
    : txKey("repay", p.user, p.amountRaw),
  user: p.user,
  calls: () => batch(p),
  activity: [{ kind: "repay", symbol: "USDC", amount: p.amount }],
});

/** What a repay with free shares signs (Repay's "Pay with" a stock held free). */
export type FreeRepayInput = {
  user: `0x${string}`;
  stock: ReserveAsset;
  /** The quote the screen shows, for the shares it sells. */
  quote: SellQuote;
  /** planSell (free shares) for that quote: its stop, the shares and what the sale pays. */
  plan: SellPlan;
  /** Aave's price for the stock, for the swap's floor (the holding's priceUsd). */
  oraclePriceUsd: number;
  /** What's owed (the position's debtRaw): the repay is never more than a full repay of it. */
  debtRaw: bigint;
  /** The cash can't keep the network-fee buffer, so the sale pays the fee. */
  feeFromSale: boolean;
};

export const FREE_REPAY_FALLBACK =
  "This repay would fail right now — the price may have moved or the stock may be paused. Try again in a moment.";

/**
 * What a repay with free shares signs (useTx), keyed by what shapes its batch: the account, the stock, the quote and its
 * floor, who pays the fee, the stop, and whether the floor covers what's owed. Not what's owed itself, as a repay by
 * selling: it accrues every block, and the batch only changes when the floor stops (or starts) covering it.
 */
export const freeRepayPlan = (p: FreeRepayInput, batch: Batch<FreeRepayInput>): TxPlan => {
  const floor = sellMinOut(p.quote, p.stock, p.oraclePriceUsd);
  const repayRaw = freeRepayRaw(floor, p.debtRaw, p.feeFromSale);
  return {
    key: txKey(
      "repay-free",
      p.user,
      p.stock.symbol,
      quoteKey(p.quote),
      floor,
      p.feeFromSale,
      p.plan.block ?? null,
      repayRaw > p.debtRaw ? "full" : "part",
    ),
    user: p.user,
    calls: () => batch(p),
    fallback: FREE_REPAY_FALLBACK,
    activity: freeRepayActivity(p.stock, p.plan, repayRaw),
  };
};

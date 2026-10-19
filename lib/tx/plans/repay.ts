import { freeRepayActivity, freeRepayRaw, type SellPlan } from "@/lib/sell";
import { quoteKey } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import type { ReserveAsset } from "@/lib/tokens/registry";
import { txKey, type TxPlan } from "../prepared";
import type { Batch } from "./types";

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

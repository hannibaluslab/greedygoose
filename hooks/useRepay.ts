"use client";

import { usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { TxStop, txKey, useTx, type TxPlan } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { salePlan, useSaleBatch, type SellInput } from "./useSell";
import { useSigningCash } from "./useSigningCash";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildRepayCalls, fullRepayAmount } from "@/lib/aave/tx";
import type { Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { cantRepay, cashShort, maxSpendRaw, payFromCash, readCash } from "@/lib/cash";
import type { RepayView } from "@/lib/repay";
import { buildFreeRepayCalls, freeRepayActivity, freeRepayRaw, type SellPlan } from "@/lib/sell";
import { quoteKey } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

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
 * Repay's batch, built from fresh reads while the screen is idle, paid from the cash as one pot (D20):
 * - a chip repays its amount, with the cash read again (useSigningCash);
 * - All that covers what's owed reads the debt and the cash then and repays the debt plus Aave's interest buffer, so
 *   the interest that accrues every block doesn't make it a new batch each time the position re-reads; if the cash no
 *   longer covers it, it stops with the words for that and the screen re-reads;
 * - All that doesn't ("All cash") repays exactly the amount on screen, with the cash read again.
 */
export function useRepayBatch() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const cashToSign = useSigningCash();
  return async (p: RepayInput): Promise<Call[]> => {
    if (!p.all || !p.coversAll) {
      const cash = await cashToSign(p.user, p.amountRaw);
      return payFromCash(p.user, p.amountRaw, cash, buildRepayCalls({ user: p.user, amountRaw: p.amountRaw, all: p.all }));
    }
    const [debtRaw, cash] = await Promise.all([
      client!.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), p.user] }),
      readCash(client!, p.user),
    ]);
    // The screen said "Repaid all your credit": cash that no longer covers it would repay less. Stop, and re-read.
    const short = debtRaw > 0n ? cashShort(debtRaw, cash) : null;
    if (short) {
      void queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      throw new TxStop(short);
    }
    const amountRaw = fullRepayAmount(debtRaw, maxSpendRaw(cash));
    if (amountRaw <= 0n) throw new TxStop(cantRepay(cash));
    return payFromCash(p.user, amountRaw, cash, buildRepayCalls({ user: p.user, amountRaw, all: true }));
  };
}

/**
 * What Repay signs (useTx), keyed by what shapes its batch: a chip by its exact amount; All by whether it covers
 * what's owed, and, when it doesn't, by the dollars on screen to the cent (the cash it spends), so a batch for other
 * cash is never signed.
 */
export const repayPlan = (p: RepayInput, batch: ReturnType<typeof useRepayBatch>): TxPlan => ({
  key: p.all ? txKey("repay", p.user, "all", p.coversAll ? "full" : Math.round(p.amount * 100)) : txKey("repay", p.user, p.amountRaw),
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

const FREE_REPAY_FALLBACK = "This repay would fail right now — the price may have moved or the stock may be paused. Try again in a moment.";

/**
 * A repay with free shares, built from fresh reads before JAW's sheet: the screen's stop still holds, the quote is read
 * again on its pool (QUOTE_MOVED when it fell under the screen's floor), and the batch is the screen's own quote, so what
 * it repays is exactly what the screen said: the sale's floor (less the fee buffer when the sale pays the fee), never
 * more (`buildFreeRepayCalls`). When the cash pays the network fee it is read again too, and a savings withdrawal goes
 * first if the wallet can't be counted on for the fee (`payFromCash`, as the Trade sheet's swap).
 */
export function useFreeRepayBatch() {
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
  return async (p: FreeRepayInput): Promise<Call[]> => {
    if (p.plan.block) throw new TxStop(FREE_REPAY_FALLBACK);
    await quoteToSign(p.stock, p.quote, "sell");
    const calls = buildFreeRepayCalls({ user: p.user, stock: p.stock, quote: p.quote, oraclePriceUsd: p.oraclePriceUsd, debtRaw: p.debtRaw, feeFromSale: p.feeFromSale });
    return p.feeFromSale ? calls : payFromCash(p.user, 0n, await cashToSign(p.user, 0n), calls);
  };
}

/**
 * What a repay with free shares signs (useTx), keyed by what shapes its batch: the account, the stock, the quote and its
 * floor, who pays the fee, the stop, and whether the floor covers what's owed. Not what's owed itself, as a repay by
 * selling: it accrues every block, and the batch only changes when the floor stops (or starts) covering it.
 */
export const freeRepayPlan = (p: FreeRepayInput, batch: ReturnType<typeof useFreeRepayBatch>): TxPlan => {
  const floor = sellMinOut(p.quote, p.stock, p.oraclePriceUsd);
  const repayRaw = freeRepayRaw(floor, p.debtRaw, p.feeFromSale);
  return {
    key: txKey("repay-free", p.user, p.stock.symbol, quoteKey(p.quote), floor, p.feeFromSale, p.plan.block ?? null, repayRaw > p.debtRaw ? "full" : "part"),
    user: p.user,
    calls: () => batch(p),
    fallback: FREE_REPAY_FALLBACK,
    activity: freeRepayActivity(p.stock, p.plan, repayRaw),
  };
};

/** What the Repay sheet signs, per "Pay with" row. */
type RepaySign = { via: "cash"; input: RepayInput } | { via: "free"; input: FreeRepayInput } | { via: "backing"; input: SellInput };

/** What the Repay sheet would sign for the row and amount on screen, once it's ready (null while it isn't). */
export function repaySign(view: RepayView, user: `0x${string}`, debtRaw: bigint): RepaySign | null {
  if (!view.ready) return null;
  const { source, sellPlan, quote } = view;
  if (source.kind === "cash") {
    return { via: "cash", input: { user, all: view.all, coversAll: view.coversAll, amount: view.repayUsd, amountRaw: view.repayRaw } };
  }
  if (!source.stock || !source.holding || !sellPlan || !quote) return null;
  const sale = { user, stock: source.stock, quote, plan: sellPlan, oraclePriceUsd: source.holding.priceUsd, debtRaw };
  return source.kind === "free" ? { via: "free", input: { ...sale, feeFromSale: source.feeFromSale } } : { via: "backing", input: sale };
}

/**
 * The Repay sheet's one write path: one useTx, one batch per "Pay with" row, prepared while the sheet is open and idle
 * from what it would sign now (`sign`, null while it can't), so the tap opens JAW's sheet straight away. Cash is
 * useRepayBatch (unchanged), a free stock useFreeRepayBatch, a backing stock the existing repay by selling (useSaleBatch).
 */
export function useRepayWith(sign: RepaySign | null) {
  const cash = useRepayBatch();
  const free = useFreeRepayBatch();
  const sale = useSaleBatch();
  const plan = !sign
    ? null
    : sign.via === "cash"
      ? repayPlan(sign.input, cash)
      : sign.via === "free"
        ? freeRepayPlan(sign.input, free)
        : salePlan(sign.input, sale);
  return useTx(undefined, plan);
}

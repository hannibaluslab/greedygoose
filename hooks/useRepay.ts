"use client";

import { usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { TxStop, useTx } from "./useTx";
import { useSigningQuote } from "./useBuyQuote";
import { salePlan, useSaleBatch, type SellInput } from "./useSell";
import { useSigningCash } from "./useSigningCash";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildRepayCalls, fullRepayAmount } from "@/lib/aave/tx";
import type { Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { cantRepay, cashShort, maxSpendRaw, payFromCash } from "@/lib/cash";
import { readCash } from "@/lib/cash/read";
import type { RepayView } from "@/lib/repay";
import { freeUpFloor } from "@/lib/freeUpPlan";
import { buildFreeRepayCalls } from "@/lib/sell";
import type { HealthFloor } from "@/lib/tx/prepared";
import { USDC } from "@/lib/tokens/registry";
import {
  FREE_REPAY_FALLBACK,
  freeRepayPlan,
  repayPlan,
  takeOutPlan,
  withTakeOuts,
  type FreeRepayInput,
  type RepayInput,
  type TakeOut,
} from "@/lib/tx/plans";

/**
 * Repay's batch, built from fresh reads while the screen is idle, paid from the cash as one pot (D20):
 * - a chip repays its amount, with the cash read again (useSigningCash);
 * - All that covers what's owed reads the debt and the cash then and repays the debt plus Aave's interest buffer, so
 *   the interest that accrues every block doesn't make it a new batch each time the position re-reads; if the cash no
 *   longer covers it, it stops with the words for that and the screen re-reads;
 * - All that doesn't ("All cash") repays exactly the amount on screen, with the cash read again.
 */
function useRepayBatch() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const cashToSign = useSigningCash();
  return async (p: RepayInput): Promise<Call[]> => {
    if (!p.all || !p.coversAll) {
      const cash = await cashToSign(p.user, p.amountRaw);
      return payFromCash(p.user, p.amountRaw, cash, buildRepayCalls({ user: p.user, amountRaw: p.amountRaw }));
    }
    const [debtRaw, cash] = await Promise.all([
      client!.readContract({
        address: AAVE.SPOKE,
        abi: spokeAbi,
        functionName: "getUserTotalDebt",
        args: [BigInt(USDC.reserveId), p.user],
      }),
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
    return payFromCash(p.user, amountRaw, cash, buildRepayCalls({ user: p.user, amountRaw }));
  };
}

/**
 * A repay with free shares, built from fresh reads before JAW's sheet: the screen's stop still holds, the quote is read
 * again on its pool (QUOTE_MOVED when it fell under the screen's floor), and the batch is the screen's own quote, so what
 * it repays is exactly what the screen said: the sale's floor (less the fee buffer when the sale pays the fee), never
 * more (`buildFreeRepayCalls`). When the cash pays the network fee it is read again too, and a savings withdrawal goes
 * first if the wallet can't be counted on for the fee (`payFromCash`, as the Trade sheet's swap).
 */
function useFreeRepayBatch() {
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();
  return async (p: FreeRepayInput): Promise<Call[]> => {
    if (p.plan.block) throw new TxStop(FREE_REPAY_FALLBACK);
    await quoteToSign(p.stock, p.quote, "sell");
    const calls = buildFreeRepayCalls({
      user: p.user,
      stock: p.stock,
      quote: p.quote,
      oraclePriceUsd: p.oraclePriceUsd,
      debtRaw: p.debtRaw,
      feeFromSale: p.feeFromSale,
    });
    return p.feeFromSale ? calls : payFromCash(p.user, 0n, await cashToSign(p.user, 0n), calls);
  };
}

/** What the Repay sheet signs, per "Pay with" row. */
type RepaySign =
  | { via: "cash"; input: RepayInput }
  | { via: "free"; input: FreeRepayInput }
  | { via: "backing"; input: SellInput };

/** What the Repay sheet would sign for the row and amount on screen, once it's ready (null while it isn't). */
export function repaySign(view: RepayView, user: `0x${string}`, debtRaw: bigint, rescuing = false): RepaySign | null {
  if (!view.ready) return null;
  const { source, sellPlan, quote } = view;
  if (source.kind === "cash") {
    return {
      via: "cash",
      input: {
        user,
        all: view.all,
        coversAll: view.coversAll,
        amount: view.repayUsd,
        amountRaw: view.repayRaw,
        rescuing,
      },
    };
  }
  if (!source.stock || !source.holding || !sellPlan || !quote) return null;
  const sale = {
    user,
    stock: source.stock,
    quote,
    plan: sellPlan,
    oraclePriceUsd: source.holding.priceUsd,
    debtRaw,
    rescuing,
  };
  return source.kind === "free"
    ? { via: "free", input: { ...sale, feeFromSale: source.feeFromSale } }
    : { via: "backing", input: sale };
}

/**
 * The Repay sheet's one write path: one useTx, one batch per "Pay with" row, prepared while the sheet is open and idle
 * from what it would sign now (`sign`, null while it can't), so the tap opens JAW's sheet straight away. Cash is
 * useRepayBatch (unchanged), a free stock useFreeRepayBatch, a backing stock the existing repay by selling (useSaleBatch).
 * The stocks ticked to free up are taken out after the repay in the same batch (withTakeOuts); with nothing repaid,
 * the take-outs alone (takeOutPlan), held to `floor` (freeUpFloor of the position's line). `ready` false keeps nothing
 * prepared (the tick not given yet).
 */
export function useRepayWith(
  sign: RepaySign | null,
  takeOuts: readonly TakeOut[] = [],
  user: `0x${string}` | null = null,
  ready = true,
  floor: HealthFloor = freeUpFloor(),
) {
  const cash = useRepayBatch();
  const free = useFreeRepayBatch();
  const sale = useSaleBatch();
  const repay = !sign
    ? null
    : sign.via === "cash"
      ? repayPlan(sign.input, cash)
      : sign.via === "free"
        ? freeRepayPlan(sign.input, free)
        : salePlan(sign.input, sale);
  const plan = !ready
    ? null
    : repay
      ? withTakeOuts(repay, takeOuts, floor)
      : user && takeOuts.length > 0
        ? takeOutPlan(user, takeOuts, floor)
        : null;
  return useTx(undefined, plan);
}

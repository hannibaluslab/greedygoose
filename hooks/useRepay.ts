"use client";

import { usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { TxStop, txKey, type TxPlan } from "./useTx";
import { useSigningCash } from "./useSigningCash";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildRepayCalls, fullRepayAmount } from "@/lib/aave/tx";
import type { Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { cantRepay, cashShort, maxSpendRaw, payFromCash, readCash } from "@/lib/cash";
import { USDC } from "@/lib/tokens/registry";

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

"use client";

import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { TxStop, txKey, type TxPlan } from "./useTx";
import { useSigningCash } from "./useSigningCash";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildRepayCalls, buildWithdrawCalls, fullRepayAmount, type Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { cantRepay, cashShort, maxSpendRaw, payFromCash, readCash } from "@/lib/cash";
import { FREE_UP_FLOOR, type FreeUpByRepay } from "@/lib/freeUp";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

/** What Free up signs: a repay from the cash (none when it can all come back now), then the shares out of backing. */
type FreeUpInput = Pick<FreeUpByRepay, "repayUsd" | "repaysAll" | "backRaw" | "all"> & {
  user: `0x${string}`;
  stock: ReserveAsset;
};

const repayRaw = (usd: number) => parseUnits(usd.toFixed(USDC.decimals), USDC.decimals);

/**
 * Free up's batch, built from fresh reads (Adrian, 2026-10-15: one amount, what you repay, and what comes back):
 * - no repay: the withdraw alone;
 * - a repay of everything owed: the debt and the cash read again, a full repay with Aave's interest buffer (as Repay's
 *   All), then the withdraw; if the cash no longer covers it, it stops with the words for that and the screen re-reads;
 * - any other repay: exactly the amount on screen, with the cash read again, then the withdraw.
 * The batch may not end in Act (FREE_UP_FLOOR, read on Aave in its simulation).
 */
export function useFreeUpBatch() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const cashToSign = useSigningCash();
  return async (p: FreeUpInput): Promise<Call[]> => {
    const withdraw = buildWithdrawCalls({ user: p.user, stock: p.stock, amountRaw: p.backRaw, all: p.all });
    if (p.repayUsd <= 0) return withdraw;
    if (!p.repaysAll) {
      const amountRaw = repayRaw(p.repayUsd);
      const cash = await cashToSign(p.user, amountRaw);
      return [
        ...payFromCash(p.user, amountRaw, cash, buildRepayCalls({ user: p.user, amountRaw, all: false })),
        ...withdraw,
      ];
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
    const short = debtRaw > 0n ? cashShort(debtRaw, cash) : null;
    if (short) {
      void queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      throw new TxStop(short);
    }
    if (debtRaw === 0n) return withdraw;
    const amountRaw = fullRepayAmount(debtRaw, maxSpendRaw(cash));
    if (amountRaw <= 0n) throw new TxStop(cantRepay(cash));
    return [
      ...payFromCash(p.user, amountRaw, cash, buildRepayCalls({ user: p.user, amountRaw, all: true })),
      ...withdraw,
    ];
  };
}

/** Free up's plan (useTx), keyed by what shapes its batch: the repay to the cent, the shares and whether it's all. */
export const freeUpPlan = (p: FreeUpInput, batch: ReturnType<typeof useFreeUpBatch>): TxPlan => ({
  key: txKey("free-up", p.user, p.stock.symbol, p.repaysAll ? "all" : Math.round(p.repayUsd * 100), p.backRaw, p.all),
  user: p.user,
  calls: () => batch(p),
  healthFloor: FREE_UP_FLOOR,
  activity: [
    ...(p.repayUsd > 0 ? [{ kind: "repay" as const, symbol: "USDC", amount: p.repayUsd }] : []),
    { kind: "withdraw" as const, symbol: p.stock.symbol, amount: Number(p.backRaw) / 10 ** p.stock.decimals },
  ],
});

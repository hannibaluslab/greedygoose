import { parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { assertAllowed } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { buildWithdrawSavingsCalls } from "@/lib/guardian/permission";
import { USDC } from "@/lib/tokens/registry";

/** Cash is savings (D15): wallet USDC plus the Aave V3 savings balance, in USDC raw units. */
export type Cash = { walletRaw: bigint; savingsRaw: bigint };

const usdcRaw = (usd: number) => parseUnits(usd.toFixed(USDC.decimals), USDC.decimals);
const keepBackRaw = usdcRaw(CASH.keepBackUsd);
const feeBufferRaw = usdcRaw(CASH.feeBufferUsd);

export const cashRaw = (c: Cash) => c.walletRaw + c.savingsRaw;

/** The most one buy or repay can spend: the fee buffer stays behind for the network fee. */
export function maxSpendRaw(c: Cash): bigint {
  const max = cashRaw(c) - feeBufferRaw;
  return max > 0n ? max : 0n;
}

/**
 * What a spend takes out of savings: amount + fee buffer − min(wallet USDC, keep-back).
 * Only the keep-back counts from the wallet, since Save may sweep anything above it between
 * simulation and signing. Takes all of savings when that's not enough; null when nothing is needed.
 */
export function savingsWithdrawal(amountRaw: bigint, c: Cash): { raw: bigint; all: boolean } | null {
  const fromWallet = c.walletRaw < keepBackRaw ? c.walletRaw : keepBackRaw;
  const need = amountRaw + feeBufferRaw - fromWallet;
  if (need <= 0n || c.savingsRaw === 0n) return null;
  return need < c.savingsRaw ? { raw: need, all: false } : { raw: c.savingsRaw, all: true };
}

/** Pay for a buy or repay from cash: the savings withdrawal it needs goes first, in the same batch. */
export function payFromCash(user: `0x${string}`, amountRaw: bigint, c: Cash, spend: Call[]): Call[] {
  if (amountRaw > maxSpendRaw(c)) throw new Error("More than your cash");
  const w = savingsWithdrawal(amountRaw, c);
  return assertAllowed(w ? [...buildWithdrawSavingsCalls(user, w.raw, w.all), ...spend] : spend);
}

import { parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { assertAllowed, type AllowContext } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { JOBS } from "@/lib/agents/permissions";
import { formatUsd } from "@/lib/formatting";
import { buildWithdrawSavingsCalls } from "@/lib/savings";
import { USDC } from "@/lib/tokens/registry";

/**
 * Cash is savings (D15): wallet USDC plus the Aave V3 savings balance, in USDC raw units. `saveOn` says whether an agent
 * may move the wallet's cash above the keep-back for the account (`walletSwept`, read from GooseGuard).
 */
/** `rescuing`: a rescue Protect started is on (GooseGuard's `accountOf(account).rescueAt` isn't 0); absent = none. */
export type Cash = { walletRaw: bigint; savingsRaw: bigint; saveOn: boolean; rescuing?: boolean };

const usdcRaw = (usd: number) => parseUnits(usd.toFixed(USDC.decimals), USDC.decimals);
const keepBackRaw = usdcRaw(CASH.keepBackUsd);
export const feeBufferRaw = usdcRaw(CASH.feeBufferUsd);

export const cashRaw = (c: Cash) => c.walletRaw + c.savingsRaw;
/** The cash can't keep the network-fee buffer, so a sale (Trade's stock → stock, Repay's) pays its own fee. */
export const feeFromSale = (cash: Cash) => cashRaw(cash) < feeBufferRaw;
export const toUsd = (raw: bigint) => Number(raw) / 10 ** USDC.decimals;

/** Whether Save runs for the account, from the job bits of GooseGuard's `accountOf(account)`. */
export const saveRuns = (jobs: number) => (jobs & (1 << JOBS.indexOf("save"))) !== 0;

/**
 * Whether an agent may move the wallet's cash above the keep-back between a batch's simulation and its signing: Save
 * (into savings), or the Rebalancer with top-ups on (into the mix, GooseGuard's wallet rule).
 */
export const walletSwept = (jobs: number, topUpsOn: boolean) =>
  saveRuns(jobs) || (topUpsOn && (jobs & (1 << JOBS.indexOf("rebalance"))) !== 0);

/** Whether Protector's repay from cash runs for the account (the same job bits): it acts under 1.03. */
export const protectRuns = (jobs: number) => (jobs & (1 << JOBS.indexOf("protect"))) !== 0;

/** The most one buy or repay can spend: the fee buffer stays behind for the network fee. */
export function maxSpendRaw(c: Cash): bigint {
  const max = cashRaw(c) - feeBufferRaw;
  return max > 0n ? max : 0n;
}

/**
 * What a spend takes out of savings: amount + fee buffer − what the wallet can be counted on for.
 * While Save is on, that is min(wallet USDC, keep-back): Save may sweep anything above the keep-back between
 * simulation and signing. With Save off nothing moves the wallet, so all of it counts: wallet USDC first, then
 * savings. Takes all of savings when that's not enough; null when nothing is needed.
 */
export function savingsWithdrawal(amountRaw: bigint, c: Cash): { raw: bigint; all: boolean } | null {
  const fromWallet = !c.saveOn || c.walletRaw < keepBackRaw ? c.walletRaw : keepBackRaw;
  const need = amountRaw + feeBufferRaw - fromWallet;
  if (need <= 0n || c.savingsRaw === 0n) return null;
  return need < c.savingsRaw ? { raw: need, all: false } : { raw: c.savingsRaw, all: true };
}

/**
 * Why the Repay screen offers no amount (maxSpendRaw is 0): there's no cash, or no more than the fee buffer, which
 * stays for the network fee. Cash counts savings and wallet USDC alike (D15).
 */
export function cantRepay(c: Cash): string {
  return cashRaw(c) === 0n
    ? "Top up your cash to repay."
    : `Repaying needs more than ${formatUsd(CASH.feeBufferUsd)} in your cash. That much stays for the network fee.`;
}

/**
 * Why a spend of `amountRaw` can't be signed with the cash there is now, `c`: it and the network fee no longer fit,
 * because cash moved since the screen showed it (another app spent it, or Protect repaid from savings). Null when they fit.
 */
export function cashShort(amountRaw: bigint, c: Cash): string | null {
  if (amountRaw + feeBufferRaw <= cashRaw(c)) return null;
  return `Your cash moved since you started. You have ${formatUsd(toUsd(cashRaw(c)))} now. Check the amount and try again.`;
}

/**
 * Pay for a buy, repay or send from cash: the savings withdrawal it needs goes first, in the same batch.
 * `amountRaw` can be 0 (a Credit Buy spends only credit, a stock send only shares): cash still pays the network fee.
 * `own` goes to the allowlist with the batch (a Send declares who it pays).
 */
export function payFromCash(
  user: `0x${string}`,
  amountRaw: bigint,
  c: Cash,
  spend: Call[],
  own?: AllowContext,
): Call[] {
  if (amountRaw + feeBufferRaw > cashRaw(c)) throw new Error("More than your cash");
  const w = savingsWithdrawal(amountRaw, c);
  return assertAllowed(user, w ? [...buildWithdrawSavingsCalls(user, w.raw, w.all), ...spend] : spend, own);
}

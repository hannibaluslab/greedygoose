import { parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { assertAllowed, type AllowContext } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { JOBS } from "@/lib/agents/permissions";
import { floorCents, formatUsd } from "@/lib/formatting";
import { buildWithdrawSavingsCalls } from "@/lib/savings";
import { USDC } from "@/lib/tokens/registry";

/**
 * Cash is savings (D15): wallet USDC plus the Aave V3 savings balance, in USDC raw units. `saveOn` says whether the
 * Cash Agent's Save job runs for the account (GooseExecutor's registry).
 */
export type Cash = { walletRaw: bigint; savingsRaw: bigint; saveOn: boolean };

const usdcRaw = (usd: number) => parseUnits(usd.toFixed(USDC.decimals), USDC.decimals);
const keepBackRaw = usdcRaw(CASH.keepBackUsd);
export const feeBufferRaw = usdcRaw(CASH.feeBufferUsd);

export const cashRaw = (c: Cash) => c.walletRaw + c.savingsRaw;
/** The cash can't keep the network-fee buffer, so a sale (Trade's stock → stock, Repay's) pays its own fee. */
export const feeFromSale = (cash: Cash) => cashRaw(cash) < feeBufferRaw;
/**
 * How much of the fuel tank (the cash kept back for network fees) is there, in whole cents rounded down: a tank a
 * fraction of a cent short never reads full.
 */
export const fuelTankUsd = (cashUsd: number) =>
  Math.min(floorCents(cashUsd), Math.round(CASH.feeBufferUsd * 100) / 100);
export const toUsd = (raw: bigint) => Number(raw) / 10 ** USDC.decimals;

/** Whether Save runs for the account, from the job bits of GooseExecutor's `accounts(account)`. */
export const saveRuns = (jobs: number) => (jobs & (1 << JOBS.indexOf("save"))) !== 0;

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
    ? "Add money to your cash to repay."
    : `Repaying needs more than ${formatUsd(CASH.feeBufferUsd)} in your cash: that much stays for the network fee.`;
}

/**
 * Why a spend of `amountRaw` can't be signed with the cash there is now, `c`: it and the network fee no longer fit,
 * because cash moved since the screen showed it (another app spent it, or Protect repaid from savings). Null when they fit.
 */
export function cashShort(amountRaw: bigint, c: Cash): string | null {
  if (amountRaw + feeBufferRaw <= cashRaw(c)) return null;
  return `Your cash moved since you started. You have ${formatUsd(toUsd(cashRaw(c)))} now: check the amount and try again.`;
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

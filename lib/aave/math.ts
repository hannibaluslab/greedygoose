import { decodeFunctionResult, type Hex } from "viem";
import { ORACLE_DECIMALS, RAY, VALUE_PER_USD, WAD } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";

/** Spoke `UserAccountData`, as returned on-chain. */
export type AccountData = {
  riskPremium: bigint;
  avgCollateralFactor: bigint; // WAD
  healthFactor: bigint; // WAD, max uint when no debt
  totalCollateralValue: bigint; // Value units (1e26 = $1)
  totalDebtValueRay: bigint; // Value units * RAY
  activeCollateralCount: bigint;
  borrowCount: bigint;
};

const MAX_UINT = 2n ** 256n - 1n;

/** Value units → USD, keeping 6 decimals of precision before going to float. */
export const valueToUsd = (v: bigint) => Number(v / (VALUE_PER_USD / 1_000_000n)) / 1_000_000;

export function summarize(d: AccountData) {
  const collateralUsd = valueToUsd(d.totalCollateralValue);
  // Debt rounds up to the cent so we never understate what is owed.
  const debtUsd = Math.ceil(Number(d.totalDebtValueRay / RAY / (VALUE_PER_USD / 100n)) + (d.totalDebtValueRay % (RAY * (VALUE_PER_USD / 100n)) > 0n ? 1 : 0)) / 100;
  const borrowLimitUsd = (collateralUsd * Number(d.avgCollateralFactor)) / Number(WAD);
  const healthFactor = d.healthFactor === MAX_UINT ? null : Number(d.healthFactor) / Number(WAD);
  return {
    collateralUsd,
    debtUsd,
    /** Aave's own limit minus current debt; display only — writes are simulated. */
    availableUsd: Math.max(0, borrowLimitUsd - debtUsd),
    healthFactor,
    avgCf: Number(d.avgCollateralFactor) / Number(WAD),
  };
}

/** The health factor in a `getUserAccountData` result (lib/aave/tx.ts accountDataRead); null when nothing is owed. */
export const healthFromAccountData = (data: Hex): number | null =>
  summarize(decodeFunctionResult({ abi: spokeAbi, functionName: "getUserAccountData", data }) as AccountData).healthFactor;

/** Health factor after changing debt/collateral, using the position's current weighted CF. */
export function projectHealth(p: { collateralUsd: number; debtUsd: number; avgCf: number }): number | null {
  if (p.debtUsd <= 0) return null;
  return (p.collateralUsd * p.avgCf) / p.debtUsd;
}

export const priceToUsd = (price: bigint) => Number(price) / 10 ** ORACLE_DECIMALS;

/** Hub drawn rate is a RAY-scaled APR; user rate adds the risk premium (bps of drawn). */
export function borrowApr(drawnRateRay: bigint, riskPremiumBps: bigint = 0n): number {
  const base = Number(drawnRateRay) / Number(RAY);
  return base * (1 + Number(riskPremiumBps) / 10_000);
}

export const monthlyCost = (debtUsd: number, apr: number) => (debtUsd * apr) / 12;

const SECONDS_PER_YEAR = 31_536_000;

/** Aave V3 quotes the savings rate as an APR that compounds every second; the boards show it as an APY. */
export const aprToApy = (apr: number) => (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1;

/**
 * Most USD of one collateral that can be withdrawn while the health factor stays at or above
 * `targetHf`: Aave's limit (1) by default, the Safe line when a sale must keep the loan Safe. Uses
 * the position's weighted collateral factor. Display only — Aave re-checks on-chain.
 */
export function maxWithdrawUsd(p: { collateralUsd: number; avgCf: number; debtUsd: number; cf: number; lockedUsd: number; targetHf?: number }): number {
  if (p.debtUsd <= 0) return p.lockedUsd;
  if (p.cf <= 0) return p.lockedUsd;
  const room = p.collateralUsd * p.avgCf - p.debtUsd * Math.max(1, p.targetHf ?? 1);
  return Math.max(0, Math.min(p.lockedUsd, room / p.cf));
}

/** Health factor after removing `usd` of a collateral with factor `cf`. */
export function healthAfterWithdraw(p: { collateralUsd: number; avgCf: number; debtUsd: number; cf: number; usd: number }): number | null {
  if (p.debtUsd <= 0) return null;
  return (p.collateralUsd * p.avgCf - p.usd * p.cf) / p.debtUsd;
}

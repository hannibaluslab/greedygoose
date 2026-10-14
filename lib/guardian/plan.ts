import { parseUnits } from "viem";
import { CASH, CASH_AGENT } from "@/config/risk";

/**
 * Guardian's decision for one account. Pure — the keeper and the app's preview share it.
 *
 * - Trigger: health factor below the Safe line (i.e. the loan is in Watch or Act).
 * - Target: repay enough to reach `targetHf` (a bit above Safe, so it doesn't fire again on the next tick).
 * - Weekend Shield: shortly before stock prices freeze, check a stressed price (e.g. −15% at Monday's open);
 *   if that stressed health would fall below `stressFloorHf`, trim now so it wouldn't.
 * - Never more than the savings balance, the remaining daily cap, or the debt itself.
 */
export type GuardianInput = {
  collateralUsd: number;
  avgCf: number;
  debtUsd: number;
  savingsUsd: number;
  capLeftUsd: number;
  /** True in the window before stock prices freeze for the weekend. */
  weekendWindow: boolean;
  triggerHf?: number;
  targetHf?: number;
  stressDrop?: number;
  stressFloorHf?: number;
  /** Don't bother below this (gas would dominate). */
  minRepayUsd?: number;
};

export type GuardianDecision =
  | { action: "none"; reason: "no-debt" | "healthy" | "no-savings" | "no-cap" | "too-small"; hf: number | null }
  | { action: "repay"; amountUsd: number; reason: "watch" | "weekend-shield"; hf: number; hfAfter: number; limitedBy?: "savings" | "cap" };

const GUARDIAN_DEFAULTS = {
  triggerHf: CASH_AGENT.triggerHf, // 1.5
  targetHf: CASH_AGENT.targetHf, // 1.65
  stressDrop: CASH_AGENT.stressDrop,
  stressFloorHf: CASH_AGENT.stressFloorHf, // 1.1
  minRepayUsd: CASH_AGENT.minRepayUsd,
} as const;

export function planGuardian(i: GuardianInput): GuardianDecision {
  const o = { ...GUARDIAN_DEFAULTS, ...strip(i) };
  if (i.debtUsd <= 0) return { action: "none", reason: "no-debt", hf: null };
  const power = i.collateralUsd * i.avgCf;
  const hf = power / i.debtUsd;
  const stressedHf = (power * (1 - o.stressDrop)) / i.debtUsd;

  let need = 0;
  let reason: "watch" | "weekend-shield" | null = null;
  if (hf < o.triggerHf) {
    need = i.debtUsd - power / o.targetHf;
    reason = "watch";
  } else if (i.weekendWindow && stressedHf < o.stressFloorHf) {
    // Make the stressed HF reach the floor plus the same headroom as normal.
    need = i.debtUsd - (power * (1 - o.stressDrop)) / (o.stressFloorHf + (o.targetHf - o.triggerHf));
    reason = "weekend-shield";
  }
  if (!reason || need <= 0) return { action: "none", reason: "healthy", hf };
  if (i.savingsUsd <= 0) return { action: "none", reason: "no-savings", hf };
  if (i.capLeftUsd <= 0) return { action: "none", reason: "no-cap", hf };

  let amount = Math.min(need, i.debtUsd);
  let limitedBy: "savings" | "cap" | undefined;
  if (amount > i.savingsUsd) {
    amount = i.savingsUsd;
    limitedBy = "savings";
  }
  if (amount > i.capLeftUsd) {
    amount = i.capLeftUsd;
    limitedBy = "cap";
  }
  if (amount < o.minRepayUsd) return { action: "none", reason: "too-small", hf };
  const left = i.debtUsd - amount;
  return { action: "repay", amountUsd: amount, reason, hf, hfAfter: left > 0 ? power / left : Infinity, limitedBy };
}

/**
 * Save's decision for one account: wallet USDC above the keep-back goes into savings, within what's left of
 * today's limit and at most `maxSavesPerDay` times a New York day. Integer USDC units, so GooseExecutor's port
 * (contracts/src/CashRules.sol) must agree exactly. Save never leaves the wallet below the keep-back.
 */
export type SaveInput = {
  walletRaw: bigint;
  capLeftRaw: bigint;
  /** Saves already made today. */
  savesToday: number;
  keepBackRaw?: bigint;
  minSaveRaw?: bigint;
  maxSavesPerDay?: number;
};

export type SaveDecision = { action: "none"; reason: "too-small" | "no-cap" | "rate" } | { action: "save"; amountRaw: bigint };

const usdc = (usd: number) => parseUnits(usd.toFixed(6), 6);

export function planSave(i: SaveInput): SaveDecision {
  const keepBack = i.keepBackRaw ?? usdc(CASH.keepBackUsd);
  const minSave = i.minSaveRaw ?? usdc(CASH_AGENT.minSaveUsd);
  const idle = i.walletRaw > keepBack ? i.walletRaw - keepBack : 0n;
  if (idle < minSave) return { action: "none", reason: "too-small" };
  if (i.capLeftRaw <= 0n) return { action: "none", reason: "no-cap" };
  if (i.savesToday >= (i.maxSavesPerDay ?? CASH_AGENT.maxSavesPerDay)) return { action: "none", reason: "rate" };
  const amountRaw = idle < i.capLeftRaw ? idle : i.capLeftRaw;
  if (amountRaw < minSave) return { action: "none", reason: "too-small" };
  return { action: "save", amountRaw };
}

function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Weekend window: Friday from 14:00 until the 20:00 ET freeze. The keeper also re-checks
 * stressed health on every tick inside the window.
 */
export function inWeekendWindow(now: Date = new Date()): boolean {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  return parts.weekday === "Fri" && hour >= 14 && hour < 20;
}

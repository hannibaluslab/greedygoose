import { parseUnits } from "viem";
import { CASH, CASH_AGENT } from "@/config/risk";

/**
 * Protect's decision for one account (from cash). Pure — the keeper and the app's preview share it, and GooseExecutor's
 * CashRules.sol ports it line for line.
 *
 * Act is the line (Adrian, 2026-10-15: "watch is ok, it is act that is not, also the guardian should only act on act
 * and not take decision and repays under watch"):
 * - Trigger: health factor below `triggerHf`, the Act line. In Safe or Watch it does nothing.
 * - Target: repay just enough to reach `targetHf`, back in Watch with room (1.2), not back to Safe.
 * - Never more than the savings balance, the remaining daily cap, or the debt itself.
 *
 * Weekend Shield no longer repays: before a freeze the credit is outside Act by definition, so it is a heads-up card
 * only (`weekendHeadsUp`), and the executor has no weekend move.
 */
type ProtectInput = {
  collateralUsd: number;
  avgCf: number;
  debtUsd: number;
  savingsUsd: number;
  capLeftUsd: number;
  triggerHf?: number;
  targetHf?: number;
  /** Don't bother below this (gas would dominate). */
  minRepayUsd?: number;
};

type ProtectDecision =
  | { action: "none"; reason: "no-debt" | "healthy" | "no-savings" | "no-cap" | "too-small"; hf: number | null }
  | { action: "repay"; amountUsd: number; reason: "act"; hf: number; hfAfter: number; limitedBy?: "savings" | "cap" };

const PROTECT_DEFAULTS = {
  triggerHf: CASH_AGENT.triggerHf, // 1.1, the Act line
  targetHf: CASH_AGENT.targetHf, // 1.2, in Watch
  minRepayUsd: CASH_AGENT.minRepayUsd,
} as const;

export function planProtect(i: ProtectInput): ProtectDecision {
  const o = { ...PROTECT_DEFAULTS, ...strip(i) };
  if (i.debtUsd <= 0) return { action: "none", reason: "no-debt", hf: null };
  const power = i.collateralUsd * i.avgCf;
  const hf = power / i.debtUsd;
  // Safe and Watch are fine: Protect steps in only in Act.
  if (hf >= o.triggerHf) return { action: "none", reason: "healthy", hf };
  const need = i.debtUsd - power / o.targetHf;
  if (need <= 0) return { action: "none", reason: "healthy", hf };
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
  return {
    action: "repay",
    amountUsd: amount,
    reason: "act",
    hf,
    hfAfter: left > 0 ? power / left : Infinity,
    limitedBy,
  };
}

/**
 * The weekend heads-up: what Weekend Shield used to repay, now only a card (Adrian, 2026-10-15: no move outside Act).
 * Shortly before stock prices freeze, a stressed price (−15% at the reopen) is tested; if it would take a credit that
 * isn't in Act today into Act, the card says so, and what repaying would keep it in Watch through that drop: the
 * stressed health back to the Act line plus the same room a repay leaves (1.1 + 0.1). Nothing moves; in Act Protect
 * acts on its own. App-only: the executor has no weekend move, and so no port of this.
 */
type WeekendHeadsUpInput = {
  collateralUsd: number;
  avgCf: number;
  debtUsd: number;
  /** True in the window before stock prices freeze for the weekend. */
  weekendWindow: boolean;
  triggerHf?: number;
  targetHf?: number;
  stressDrop?: number;
  stressFloorHf?: number;
};

type WeekendHeadsUp = { hf: number; stressedHf: number; addUsd: number };

const HEADS_UP_DEFAULTS = {
  triggerHf: CASH_AGENT.triggerHf,
  targetHf: CASH_AGENT.targetHf,
  stressDrop: CASH_AGENT.stressDrop, // 15%
  stressFloorHf: CASH_AGENT.stressFloorHf, // 1.1, the Act line
} as const;

export function weekendHeadsUp(i: WeekendHeadsUpInput): WeekendHeadsUp | null {
  const o = { ...HEADS_UP_DEFAULTS, ...strip(i) };
  if (!i.weekendWindow || i.debtUsd <= 0) return null;
  const power = i.collateralUsd * i.avgCf;
  const hf = power / i.debtUsd;
  if (hf < o.triggerHf) return null; // in Act: Protect itself steps in
  const stressedHf = (power * (1 - o.stressDrop)) / i.debtUsd;
  if (stressedHf >= o.stressFloorHf) return null;
  const addUsd = i.debtUsd - (power * (1 - o.stressDrop)) / (o.stressFloorHf + (o.targetHf - o.triggerHf));
  return addUsd > 0 ? { hf, stressedHf, addUsd } : null;
}

/**
 * Save's decision for one account: wallet USDC above the keep-back goes into savings, within what's left of
 * today's limit and at most `maxSavesPerDay` times a New York day. Integer USDC units, so GooseExecutor's port
 * (contracts/src/CashRules.sol) must agree exactly. Save never leaves the wallet below the keep-back.
 */
type SaveInput = {
  walletRaw: bigint;
  capLeftRaw: bigint;
  /** Saves already made today. */
  savesToday: number;
  keepBackRaw?: bigint;
  minSaveRaw?: bigint;
  maxSavesPerDay?: number;
};

type SaveDecision = { action: "none"; reason: "too-small" | "no-cap" | "rate" } | { action: "save"; amountRaw: bigint };

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
 * Weekend window: Friday from 14:00 until the 20:00 ET freeze, with no holiday (Leo's). The weekend heads-up card
 * reads the executor's own calendar instead (`beforeFreeze` in lib/agents/next.ts), which agrees with this on a week
 * with no holiday (contracts/test/NyCalendar.t.sol). Nothing moves in it (Act is the line, 2026-10-15).
 */
export function inWeekendWindow(now: Date = new Date()): boolean {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  return parts.weekday === "Fri" && hour >= 14 && hour < 20;
}

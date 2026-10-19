import { parseUnits } from "viem";
import { CASH, CASH_AGENT } from "@/config/risk";

/**
 * Protect's decision for one account (from cash). Pure — the app's preview uses it, and GooseExecutor's CashRules.sol
 * ports it line for line.
 *
 * Protect's line (Adrian, 2026-10-19):
 * - Trigger: health factor below `triggerHf` (1.03). Act (1.1) is a warning only; above the line it does nothing.
 * - Rescue: once Protect has acted, it goes on below `targetHf` (`rescuing`), savings first, then selling, until the
 *   credit is back at the target.
 * - Target: repay just enough to reach `targetHf` (1.12, in Watch), never more: no amount limit, as at DeFi Saver.
 * - Never more than the savings balance, what's left of the grant's limit, or the debt itself.
 *
 * Weekend Shield no longer repays: the weekend is a card only (`weekendHeadsUp`), and the executor has no weekend move.
 */
type ProtectInput = {
  totalBackingUsd: number;
  avgCf: number;
  debtUsd: number;
  savingsUsd: number;
  capLeftUsd: number;
  triggerHf?: number;
  targetHf?: number;
  /** A rescue Protect started is under way (the executor's `rescueAt`): it acts below the target, not only the line. */
  rescuing?: boolean;
  /** Don't bother below this (gas would dominate). */
  minRepayUsd?: number;
};

type ProtectDecision =
  | { action: "none"; reason: "no-debt" | "healthy" | "no-savings" | "no-cap" | "too-small"; hf: number | null }
  | { action: "repay"; amountUsd: number; reason: "act"; hf: number; hfAfter: number; limitedBy?: "savings" | "cap" };

const PROTECT_DEFAULTS = {
  triggerHf: CASH_AGENT.triggerHf, // 1.03, Protect's line
  targetHf: CASH_AGENT.targetHf, // 1.12, in Watch
  minRepayUsd: CASH_AGENT.minRepayUsd,
} as const;

export function planProtect(i: ProtectInput): ProtectDecision {
  const o = { ...PROTECT_DEFAULTS, ...strip(i) };
  if (i.debtUsd <= 0) return { action: "none", reason: "no-debt", hf: null };
  const power = i.totalBackingUsd * i.avgCf;
  const hf = power / i.debtUsd;
  // Above Protect's line it does nothing, unless a rescue it started hasn't reached the target yet.
  if (hf >= (i.rescuing ? o.targetHf : o.triggerHf)) return { action: "none", reason: "healthy", hf };
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
 * The weekend card: what Weekend Shield used to repay, now only a card. Shortly before stock prices freeze, a stressed
 * price (−15% at the reopen) is tested; if it would take the credit under Aave's line (`stressFloorHf`, 1.0), the card
 * says so, and what repaying would keep it clear of that line through the drop: the stressed health back to the line
 * plus the same margin a rescue leaves (1.0 + 0.09). Nothing moves; below its line Protect acts on its own. App-only:
 * the executor has no weekend move, and so no port of this.
 */
type WeekendHeadsUpInput = {
  totalBackingUsd: number;
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
  stressFloorHf: CASH_AGENT.stressFloorHf, // 1.0, Aave's line
} as const;

export function weekendHeadsUp(i: WeekendHeadsUpInput): WeekendHeadsUp | null {
  const o = { ...HEADS_UP_DEFAULTS, ...strip(i) };
  if (!i.weekendWindow || i.debtUsd <= 0) return null;
  const power = i.totalBackingUsd * i.avgCf;
  const hf = power / i.debtUsd;
  if (hf < o.triggerHf) return null; // below its line, Protect itself acts
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
 * Weekend window: Friday from 14:00 until the 20:00 ET freeze, with no holiday (Leo's). The weekend card
 * reads the executor's own calendar instead (`beforeFreeze` in lib/agents/next.ts), which agrees with this on a week
 * with no holiday (contracts/test/NyCalendar.t.sol). Nothing moves in it.
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

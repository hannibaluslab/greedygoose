import { CASH_AGENT, RISK } from "@/config/risk";

/*
 * Protect's line and target as each user sets them (decision 3), in GooseGuard's units: 1e-4 health, so 10300 = 1.03.
 * The Guard takes a line of 1.03 or more and a target at least 0.05 above it, at most 1.40 (`setProtect`); (0, 0)
 * means its defaults. Plain numbers, so the allowlist and the screen share one rule.
 */

export const LINE_MIN = 10_300;
export const TARGET_GAP = 500;
export const TARGET_MAX = 14_000;

/** A health factor in the Guard's units: 1.03 → 10300. */
const toLineUnits = (hf: number) => Math.round(hf * 1e4);

/** The deploy defaults (GooseGuard's DEFAULT_LINE and DEFAULT_TARGET, config/risk.ts CASH_AGENT): 1.03 and 1.12. */
export const DEFAULT_LINES = { line: toLineUnits(CASH_AGENT.triggerHf), target: toLineUnits(CASH_AGENT.targetHf) };

/** A line and target GooseGuard's `setProtect` takes. */
export const linesOk = (line: number, target: number) =>
  Number.isInteger(line) &&
  Number.isInteger(target) &&
  line >= LINE_MIN &&
  target >= line + TARGET_GAP &&
  target <= TARGET_MAX;

/** "1.03", or "1.035" for a line set outside the app to a finer step. */
export const lineText = (v: number) => (v / 1e4).toFixed(v % 100 === 0 ? 2 : v % 10 === 0 ? 3 : 4);

/** Protect's line and target as health factors: the account's own (GooseGuard's `linesOf`), else the defaults. */
export type ProtectNumbers = { line: number; target: number };
export const DEFAULT_PROTECT: ProtectNumbers = { line: CASH_AGENT.triggerHf, target: CASH_AGENT.targetHf };

/** A Protect number as the copy writes it: "1.03" (`lineText`). */
export const protectHfText = (hf: number) => lineText(Math.round(hf * 1e4));

/**
 * Where Protector brings the credit back to, as the copy says it: "Watch" when it steps in from Act and stops in Watch
 * (the defaults, 1.03 and 1.12, so the copy reads as it always has), else the target's number (a target under Act, or
 * a line raised into Watch, where "back to Watch" isn't true).
 */
export const backToText = (n: ProtectNumbers) =>
  n.line < RISK.watchMin && n.target >= RISK.watchMin ? "Watch" : protectHfText(n.target);

const sorted = (vs: number[]) => [...new Set(vs)].sort((a, b) => a - b);

/** 1.03 to 1.10 by 0.01, then by 0.05 up to 1.35: the highest line that leaves room for a target. */
const LINES = [10_300, 10_400, 10_500, 10_600, 10_700, 10_800, 10_900, 11_000, 11_500, 12_000, 12_500, 13_000, 13_500];
const TARGETS = [10_800, 11_000, 11_200, 11_500, 12_000, 12_500, 13_000, 13_500, 14_000];

/** The lines the screen offers, with `keep` (the one chosen now, the saved one) when off the list and still in range. */
export const lineOptions = (...keep: number[]) =>
  sorted([...LINES, ...keep.filter((l) => l >= LINE_MIN && l <= TARGET_MAX - TARGET_GAP)]);

/** The targets the screen offers for `line`: from 0.05 above it, with `keep` (chosen now, saved) where they still fit. */
export const targetOptions = (line: number, ...keep: number[]) =>
  sorted([...TARGETS, line + TARGET_GAP, ...keep]).filter((t) => t >= line + TARGET_GAP && t <= TARGET_MAX);

/**
 * GG-19 (Adrian): the line Protect · sell steps in under when Protect can't repay with cash (Protect off, or a wallet
 * at most the keep-back and no savings), in the Guard's units: GooseGuard's SELL_LINE_NO_CASH (1.08), a line under it
 * raised to it so a sale still has time to go through. A line at or over it is the account's own.
 */
export const SELL_LINE_NO_CASH = 10_800;

/**
 * Under "Repay from your cash" in Protect · settings: where it repays, and with selling on and a line under 1.08, that
 * with no cash it sells from 1.08 and that a very fast fall can still beat a sale (GG-19). Both two lines on a phone,
 * so the screen is no longer than before.
 */
export const repayNote = (line: number, sellOn: boolean) =>
  `Only under ${lineText(line)}, and always first. ${
    sellOn && line < SELL_LINE_NO_CASH
      ? `With no cash, it sells from ${lineText(SELL_LINE_NO_CASH)}, but a very fast fall can beat a sale.`
      : "Your cash pays before any stock is sold."
  }`;

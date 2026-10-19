import { toCents, type RepayMax } from "./sources";

/**
 * The sheet's own state: the row picked (null: the default), the amount typed, or All, and whether what was typed went
 * over the most and snapped back to it (`snapped`: the sheet says so in one line).
 */
export type RepayForm = { source: string | null; amount: string; all: boolean; snapped?: boolean };
/** The sheet opens at 0: nothing is repaid until an amount is typed, a pick is tapped or All. */
export const REPAY_FORM: RepayForm = { source: null, amount: "", all: false };
export type RepayAction =
  | { type: "source"; id: string }
  | { type: "amount"; value: string; max: RepayMax }
  | { type: "chip"; usd: number; max: RepayMax }
  | { type: "all" };

/**
 * One step of the sheet's form. A new row keeps the amount (or All). The amount is typed in dollars, and a quick pick
 * fills it. Dollars at the most the row repays are All, so typing what's owed repays all of it and frees every stock,
 * as All does; more than that (more than owed, or than the row can pay) snap back to it, All, and the sheet says so in
 * one line (NYM's clamp). So the amount is never more than owed or than the row can pay.
 */
export function repayForm(state: RepayForm, action: RepayAction): RepayForm {
  if (action.type === "source") return { source: action.id, amount: state.amount, all: state.all };
  if (action.type === "all") return { source: state.source, amount: "", all: true };
  const value = action.type === "chip" ? String(action.usd) : action.value;
  const { max } = action;
  const n = Number(value) || 0;
  const most = toCents(max.usd, max.coversAll);
  // Keys typed after a snap land on the most again (the field shows it): the line stays until the amount goes under it.
  if (!max.quoting && max.usd > 0 && n >= most) {
    return n > most || (state.snapped && state.all)
      ? { source: state.source, amount: "", all: true, snapped: true }
      : { source: state.source, amount: "", all: true };
  }
  return { source: state.source, amount: value, all: false };
}

/**
 * The quick picks (Adrian, 2026-10-15): 25%, 50% and 75% of the most the row repays, rounded down to the cent, then
 * Max. A pick under the smallest repay isn't offered.
 */
const QUICK_PICKS = [0.25, 0.5, 0.75] as const;
export const quickPicks = (max: RepayMax, minUsd = 1) =>
  QUICK_PICKS.map((share) => ({ share, usd: Math.floor(max.usd * share * 100) / 100 })).filter(
    (p) => p.usd >= minUsd && p.usd < max.usd,
  );

import { CREDIT_BLOCKED, creditBuyStop, type CreditPlan } from "@/lib/creditBuy";
import { toUsd } from "@/lib/cash";
import { costTenths, earnRates, earnTenths, marginalApy, pctText } from "@/lib/earnWithStocks";
import { formatUsdTrim } from "@/lib/formatting";

/*
 * Credit Buy's Cash row: the credit goes straight into savings, where the cash earns, in one batch (Earn with stocks'
 * batch, buildEarnCalls), backed the Credit Buy way (Credit ready, or the one stock picked on step 1). Unlike Earn with
 * stocks, it isn't closed while credit costs more than the cash earns: the gap is shown before the tap instead.
 */

/** The Cash row's line and the amount step's: "Earns 3.8% in savings". */
export const cashRowLine = (tenths: number) => `Earns ${pctText(tenths)} in savings`;
export const toCashLine = (tenths: number) => `Goes to your cash, earning ${pctText(tenths)}`;

export type ToCashQuote = {
  plan: CreditPlan;
  amountUsd: number;
  /** What the cash earns, in tenths of a point a year, rounded down. */
  earn: number;
  /** What this credit costs (marginalApy), in tenths, rounded up; null while the rate after it is read. */
  cost: number | null;
  /** What the cash earns less what the credit costs, in tenths as shown: below 0 when credit costs more. */
  gap: number | null;
};

/**
 * One amount on the Cash row: the plan on screen, what the cash earns now and what this credit costs once it lands
 * (`creditApyAfter`, read from a simulation of the batch), rounded as Earn with stocks rounds them (earnRates), so the
 * gap on screen is never shown better than it is.
 */
export function toCashQuote(p: {
  plan: CreditPlan;
  debtUsd: number;
  cashApy: number;
  creditApyNow: number;
  creditApyAfter: number | null;
}): ToCashQuote {
  const amountUsd = toUsd(p.plan.creditRaw);
  const earn = earnTenths(p.cashApy);
  if (p.creditApyAfter === null) return { plan: p.plan, amountUsd, earn, cost: null, gap: null };
  const apy = marginalApy({ debtUsd: p.debtUsd, amountUsd, apyNow: p.creditApyNow, apyAfter: p.creditApyAfter });
  const { cost, left } = earnRates(p.cashApy, apy);
  return { plan: p.plan, amountUsd, earn, cost, gap: left };
}

/**
 * The gap in one line, with what it comes to in a year at today's rates once there's an amount: a cost rounded up, a
 * gain rounded down, "under $1" below a dollar.
 */
export function gapLine(gap: number, amountUsd: number): string {
  const pct = pctText(Math.abs(gap));
  // Tenths × dollars first, then ÷ 1000, with the same epsilon as earnTenths: 1.7% of $3,000 is $51, not $52.
  const usd = (Math.abs(gap) * amountUsd) / 1000;
  const whole = gap < 0 ? Math.ceil(usd - 1e-6) : Math.floor(usd + 1e-6);
  const year = amountUsd > 0 && gap !== 0 ? `, ${usd < 1 ? "under $1" : `about ${formatUsdTrim(whole)}`} a year` : "";
  if (gap < 0) return `Costs ${pct} a year more than it earns${year}. Both rates are variable.`;
  if (gap === 0) return "Costs about what it earns. Both rates are variable.";
  return `Earns ${pct} a year more than it costs${year}. Both rates are variable.`;
}

/** The Cash row's rate when its cost can't be read: Credit Buy's own words for it. */
export const RATE_UNREAD = "Couldn’t read what this credit costs. Try again in a moment.";

/**
 * The Cost cell's rate: what this credit costs once read; today's rate while the amount is blocked (its read is off, as
 * the stock route shows its rate then); a dash when the read failed (the blocker says why); "…" only while it's read.
 */
export function costCellText(q: ToCashQuote, p: { failed: boolean; blocked: boolean; apyNow: number }): string {
  if (q.cost !== null) return pctText(q.cost);
  if (p.failed) return "—";
  if (p.blocked) return pctText(costTenths(p.apyNow));
  return "…";
}

/** Why the Cash row's amount can't be signed: none typed, a block, the rate after it still read, or the risk tick (D2). */
export function toCashStop(q: ToCashQuote, confirmedRisk: boolean): string | null {
  if (!(q.amountUsd > 0)) return "Enter an amount";
  if (q.plan.block) return CREDIT_BLOCKED[q.plan.block];
  if (q.cost === null) return "One moment…";
  return creditBuyStop(q.plan, confirmedRisk);
}

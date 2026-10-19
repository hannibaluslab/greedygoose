import { CASH } from "@/config/risk";
import { cashRaw, feeBufferRaw, type Cash } from "@/lib/cash";
import { formatUsd } from "@/lib/formatting";

/** Credit Buy's words: why a plan or Credit Buy can't go ahead, and the lines under "You can use up to". */

/** Names for one short line: "NVIDIA", "NVIDIA and Tesla", "NVIDIA and 3 more". */
export function shortNames(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more`;
}

/**
 * Why a plan can't go ahead. "in-act": the credit is in Act already, so no more is taken until it's out. "act": this
 * plan would end in Act (Act is the line, Adrian 2026-10-15): blocked, and no risk tick can let it through.
 */
export type CreditBlock = "paused" | "no-liquidity" | "over-free" | "in-act" | "act" | "too-much" | "fee";

export const CREDIT_BLOCKED: Record<CreditBlock, string> = {
  paused: "Aave isn’t giving new USDC credit right now.",
  "no-liquidity": "Aave doesn’t have enough USDC for this right now. Try a smaller amount.",
  "over-free": "That’s more than you have free to put in use. Try a smaller amount.",
  "in-act": "Your credit is in Act. Repay some to use more.",
  act: "That would put your credit in Act. Try a smaller amount.",
  "too-much": "That’s more credit than your stocks can back right now. Try a smaller amount.",
  fee: `The network fee is paid from your cash. Top up ${formatUsd(CASH.feeBufferUsd)} first.`,
};

/** Why a Credit Buy can use nothing right now (F2-3's zero state, shown at step 1). */
export type NoCredit = "no-stocks" | "cant-back" | "too-small" | "all-in-use" | "in-act" | "paused" | "no-liquidity";

/** F2-3's line under "$0", first half: why. */
export const NO_CREDIT: Record<NoCredit, string> = {
  "no-stocks": "Credit comes from your stocks",
  "cant-back": "Your stocks can’t back credit right now.",
  "too-small": "Your free stock is too small to back credit yet.",
  "all-in-use": "Your stocks already back what you owe. Repay some to use more.",
  "in-act": CREDIT_BLOCKED["in-act"],
  paused: "New credit is paused right now.",
  "no-liquidity": "There’s no credit to give out right now.",
};

/**
 * F2-3's whole line under "$0": why, then that cash still buys (a stock tapped there opens its Buy step with cash), or,
 * with too little cash for the smallest buy and its network fee, to top up first.
 */
export function noCreditLine(why: NoCredit, canPayCash: boolean): string {
  // No stocks (rulings 8, 9): the step's title says where credit comes from, so the line only says what to do.
  if (why === "no-stocks") return canPayCash ? "Buy one with your cash first." : "Top up, then buy one with your cash.";
  return `${NO_CREDIT[why]} ${canPayCash ? "You can still buy with cash." : "Top up to buy with cash."}`;
}

/** F2-3's line under the number when there is credit to use. */
export const CREDIT_FROM = "In credit, backed by the stocks you own.";
/** …and when there's credit but not the network fee: cash pays it (D4), and F2-5 would block every amount ("fee"). */
export const FEE_FIRST = `Add ${formatUsd(CASH.feeBufferUsd)} to your cash for the network fee first.`;
/** The plain line under "You can use up to": cash pays the network fee (D4), so without it the fee comes first. */
export const creditLine = (cash: Cash) => (cashRaw(cash) < feeBufferRaw ? FEE_FIRST : CREDIT_FROM);

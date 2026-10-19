import type { AgentStatus } from "@/lib/agents/status";
import { CREDIT_BLOCKED, shortNames, type CreditBlock } from "@/lib/creditBuy/copy";
import type { CreditPlan } from "@/lib/creditBuy";
import { formatShares, formatUsdTrim, inWords } from "@/lib/formatting";
import { STATUS_LABEL } from "@/lib/risk/status";
import { tickerOf } from "@/lib/tokens/registry";

/** Earn with stocks' words: why the card offers nothing, the plan's blocks in the Cash sheet's words, and the small print. */

/** Why the card offers nothing, in its one line. */
export const EARN_CLOSED = {
  "no-stocks": "Earn with stocks needs stocks that can back credit.",
  "costs-more": "Credit costs more than your cash earns right now.",
  paused: "New credit is paused right now. Try again later.",
  credit: "Your stocks can’t back more credit right now.",
  "in-act": CREDIT_BLOCKED["in-act"],
  fee: CREDIT_BLOCKED.fee,
  unread: "We couldn’t check this right now. Try again in a moment.",
} as const;
export type EarnClosed = keyof typeof EARN_CLOSED;

/** The plan's blocks in the Cash sheet's own words: no protocol names. */
export const EARN_BLOCKED: Record<CreditBlock, string> = {
  paused: EARN_CLOSED.paused,
  "no-liquidity": "There isn’t enough credit available right now. Try a smaller amount.",
  "over-free": CREDIT_BLOCKED["over-free"],
  "in-act": CREDIT_BLOCKED["in-act"],
  act: CREDIT_BLOCKED.act,
  "too-much": "That’s more credit than your stocks can back right now. Try a smaller amount.",
  fee: CREDIT_BLOCKED.fee,
};

export const EARN_COSTS_MORE = "At this amount, credit costs more than your cash earns right now.";

// ── Words around the button ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one risk line, from what Protect does now: repay from the cash, and sell a little backing stock when that's on
 * (decision 5), only once the credit reaches Act and back to Watch (Act is the line, 2026-10-15). "Protect is off" only
 * when it is.
 */
export function earnRiskLine(p: { names: readonly string[]; protect: AgentStatus; sell: AgentStatus }): string {
  const one = p.names.length === 1 ? p.names[0] : null;
  const falls = one ? `If ${one} falls` : "If your stocks fall";
  if (p.protect === "on") {
    return p.sell === "on"
      ? `${falls}, you can repay from your cash. If your credit reaches Act, Protect repays from it, then sells a little ${one ?? "of them"} to bring it back to Watch.`
      : `${falls}, you can repay from your cash. If your credit reaches Act, Protect repays from it. Protect won’t sell your ${one ? "stock" : "stocks"}.`;
  }
  const off = p.protect === "off" || p.protect === "unconfigured" ? " Protect is off." : "";
  return `${falls}, repay from your cash. If ${one ? "it falls" : "they fall"} too far, part of ${one ? "it" : "them"} can be sold to repay what you owe.${off}`;
}

/**
 * D7: every move in the batch, in small print on the signing screen, with what's owed after it, the risk and the
 * tokenized-stock line (CLAUDE.md › Compliance).
 */
export function earnSmallPrint(p: {
  backing: readonly { symbol: string; shares: number }[];
  amountUsd: number;
  owedUsd: number;
  backedBy: readonly string[];
  risk: string;
}): string {
  const moves = [
    ...p.backing.map((b) => `${formatShares(b.shares)} ${tickerOf(b.symbol)} goes in use to back credit`),
    `${formatUsdTrim(p.amountUsd)} of credit comes to your cash and starts earning`,
  ];
  // What's owed rounds up, as on Home: never shown as less than it is.
  return (
    `In one go: ${inWords(moves)}. You’ll owe ${formatUsdTrim(Math.ceil(p.owedUsd))}, backed by ${shortNames(p.backedBy)}. ` +
    p.risk
  );
}

/** The risk tick (D2), when it ends in Watch (ending in Act is blocked). */
export const earnTick = (after: CreditPlan["after"]) =>
  `I understand this puts my credit in ${STATUS_LABEL[after]}. If my stocks fall, part of them can be sold to repay what I owe.`;

export const earnDone = (amountUsd: number) => `${formatUsdTrim(amountUsd)} is in your cash, earning.`;

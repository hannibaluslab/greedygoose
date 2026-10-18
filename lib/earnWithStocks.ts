import { decodeFunctionData, erc20Abi, isAddressEqual } from "viem";
import { RISK } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildBackAndCreditCalls, type Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import type { AgentStatus } from "@/lib/agents/status";
import { cashRaw, feeBufferRaw, payFromCash, toUsd, type Cash } from "@/lib/cash";
import {
  CREDIT_BLOCKED,
  planCredit,
  shortNames,
  type Backing,
  type BackingOption,
  type CreditBlock,
  type CreditPlan,
  type CreditPosition,
} from "@/lib/creditBuy";
import { formatShares, formatUsdTrim, inWords } from "@/lib/formatting";
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { buildAddSavingsCalls } from "@/lib/savings";
import { STATUS_LABEL, statusFor } from "@/lib/risk/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import type { HealthFloor } from "@/lib/tx/prepared";

/*
 * Earn with stocks (Adrian, 2026-10-15: "use your stock to add more cash to get yield"; then "the user should be able to
 * put stocks get cash in saving"): put stocks to work as backing, take credit, and put exactly that credit where the
 * cash earns, in one user-signed batch. Pure, so the offer, its cap and its words are unit-tested and the dev gallery
 * draws every state.
 *
 * The credit earns from the moment the batch lands: the batch itself puts it in savings (the allowlist's one
 * user-signed savings supply, `saveTo`), so no agent is needed and nothing waits for Save. Both rates are variable: the
 * cash rate (Aave V3's USDC supply) and the credit's (the Hub's drawn rate with the account's risk premium), each as an
 * APY.
 */

// ── Rates ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rates on screen are in tenths of a point, rounded so the gap is never overstated: what the cash earns rounds down,
 * what the credit costs rounds up, and what's left is the difference of the two as shown, so the arithmetic on screen is
 * exact. The epsilon keeps a rate that is exactly on a tenth (4.1%) from rounding the wrong way in floating point.
 */
export const earnTenths = (apy: number) => Math.floor(apy * 1000 + 1e-6);
const costTenths = (apy: number) => Math.ceil(apy * 1000 - 1e-6);
/** Tenths of a point as on screen: 41 → "4.1%". */
export const pctText = (tenths: number) => `${(tenths / 10).toFixed(1)}%`;

/** What the cash earns, what the credit costs and what's left, in tenths of a point a year. */
export type EarnRates = { earn: number; cost: number; left: number };

export function earnRates(cashApy: number, creditApy: number): EarnRates {
  const earn = earnTenths(cashApy);
  const cost = costTenths(creditApy);
  return { earn, cost, left: earn - cost };
}

/**
 * What this credit costs a year as a rate on it (an APY): the rate and the risk premium apply to the whole debt, so
 * taking more can raise what the existing debt costs too. That rise is this credit's cost. Never less than the rate
 * the credit itself pays once it lands: if new backing ever lowered the premium on the existing debt, that saving
 * isn't counted as this credit being cheaper, so the gap shown stays a floor.
 */
export function marginalApy(p: { debtUsd: number; amountUsd: number; apyNow: number; apyAfter: number }): number {
  if (p.amountUsd <= 0) return p.apyAfter;
  return Math.max(p.apyAfter, ((p.debtUsd + p.amountUsd) * p.apyAfter - p.debtUsd * p.apyNow) / p.amountUsd);
}

// ── The offer ────────────────────────────────────────────────────────────────────────────────────────────────────────

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
type EarnClosed = keyof typeof EARN_CLOSED;

/** The smallest amount, the minimum buy's: under $1 a row's cost and earnings round to nothing. */
/** A cent: no minimum of ours (ruling 2, Oct 17). */
const EARN_MIN_USD = 0.01;

export type EarnOffer =
  | { kind: "loading" }
  /** Nothing to offer, and why; with the rates when they are the reason. */
  | { kind: "closed"; why: EarnClosed; text: string; rates?: EarnRates }
  | { kind: "offer"; rates: EarnRates; maxUsd: number; maxSafeUsd: number; minUsd: number };

export type EarnInput = {
  /** What the cash earns and what credit costs now, each an APY. */
  cashApy: number;
  creditApy: number;
  position: CreditPosition;
  /** backingOptions on the live collateral factors; undefined while they load. */
  options: BackingOption[] | undefined;
  cash: Cash;
  /** The stocks' backing couldn't be read: one line, not a skeleton. */
  unread?: boolean;
  now?: Date;
};

const closed = (why: EarnClosed, rates?: EarnRates): EarnOffer => ({
  kind: "closed",
  why,
  text: EARN_CLOSED[why],
  ...(rates ? { rates } : {}),
});

/**
 * Whether the Cash sheet offers Earn with stocks, and up to how much. It needs no agent: the batch puts the credit
 * where the cash earns itself. The first rule that matches wins: loading (or a line when the read it waits on failed);
 * no stocks that can back credit; credit costing as much as the cash earns or more (as shown, in tenths); new credit
 * paused; the credit already in Act (Act is the line: no more is taken until it's out); less than the smallest amount
 * the stocks can back (creditCap, never past the Act line's margin, as every way of taking credit; and the USDC
 * available); no cash for the network fee.
 */
export function earnOffer(i: EarnInput): EarnOffer {
  if (!i.options) return i.unread ? closed("unread") : { kind: "loading" };
  if (i.options.length === 0 && i.position.totalBackingUsd === 0) return closed("no-stocks");
  const rates = earnRates(i.cashApy, i.creditApy);
  if (rates.left <= 0) return closed("costs-more", rates);
  if (i.position.creditPaused) return closed("paused");
  if (statusFor(i.position.healthFactor) === "act") return closed("in-act");

  const plan0 = planCredit({ position: i.position, options: i.options, creditRaw: 0n, cash: i.cash, now: i.now });
  const maxUsd = Math.floor(Math.min(plan0.maxUsd, i.position.usdcLiquidity));
  if (maxUsd < EARN_MIN_USD) return closed("credit");
  if (cashRaw(i.cash) < feeBufferRaw) return closed("fee");
  return { kind: "offer", rates, maxUsd, maxSafeUsd: plan0.maxSafeUsd, minUsd: EARN_MIN_USD };
}

export type EarnOpen = Extract<EarnOffer, { kind: "offer" }>;

/** The cap in words: "Up to $1,000.". */
const limitText = (o: EarnOpen) => `Up to ${formatUsdTrim(o.maxUsd)}.`;

/** The amount field's hint: the cap, and the Safe line when it's lower. */
export function earnHint(o: EarnOpen): string {
  const safe = Math.floor(o.maxSafeUsd);
  return safe < o.maxUsd ? `${limitText(o)} Stay under ${formatUsdTrim(safe)} to stay Safe.` : limitText(o);
}

// ── One amount ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type EarnQuote = {
  plan: CreditPlan;
  amountUsd: number;
  /** This credit's cost (marginalApy) in tenths, rounded up; null while the rate after it is read. */
  cost: number | null;
  /** What's left in tenths: what the cash earns as shown, less the cost as shown. */
  left: number | null;
  /** What's left in dollars a year at today's rates, rounded down. */
  leftUsdYear: number | null;
};

/**
 * One amount on the earn step: the same plan Credit Buy uses (planCredit: what already backs credit counts first, then
 * the stock with the highest collateral factor, to start Safe; past Safe everything, with the risk tick), and what it
 * leaves once its cost is known (`creditApyAfter`, the rate after the batch, read from a simulation of it).
 */
export function earnQuote(p: {
  offer: EarnOpen;
  position: CreditPosition;
  options: BackingOption[];
  cash: Cash;
  creditRaw: bigint;
  creditApyNow: number;
  creditApyAfter: number | null;
  now?: Date;
}): EarnQuote {
  const plan = planCredit({
    position: p.position,
    options: p.options,
    creditRaw: p.creditRaw,
    cash: p.cash,
    now: p.now,
  });
  const amountUsd = toUsd(p.creditRaw);
  if (p.creditApyAfter === null || amountUsd <= 0)
    return { plan, amountUsd, cost: null, left: null, leftUsdYear: null };
  const cost = costTenths(
    marginalApy({ debtUsd: p.position.debtUsd, amountUsd, apyNow: p.creditApyNow, apyAfter: p.creditApyAfter }),
  );
  const left = p.offer.rates.earn - cost;
  return { plan, amountUsd, cost, left, leftUsdYear: Math.max(0, Math.floor((left / 1000) * amountUsd)) };
}

/** The plan's blocks in the Cash sheet's own words: no protocol names. */
const EARN_BLOCKED: Record<CreditBlock, string> = {
  paused: EARN_CLOSED.paused,
  "no-liquidity": "There isn’t enough credit available right now. Try a smaller amount.",
  "over-free": CREDIT_BLOCKED["over-free"],
  "in-act": CREDIT_BLOCKED["in-act"],
  act: CREDIT_BLOCKED.act,
  "too-much": "That’s more credit than your stocks can back right now. Try a smaller amount.",
  fee: CREDIT_BLOCKED.fee,
};

/** Its batch is stopped if the health on Aave after it, read in its own simulation, is in Act (lib/creditBuy.ts CREDIT_FLOOR). */
export const EARN_FLOOR: HealthFloor = { minHf: RISK.watchMin, stop: EARN_BLOCKED.act };

export const EARN_COSTS_MORE = "At this amount, credit costs more than your cash earns right now.";

/** Why this amount can't go ahead, in the red line under it; null when it can (the risk tick aside). */
export function earnBlock(q: EarnQuote, o: EarnOpen): string | null {
  if (q.plan.block) return EARN_BLOCKED[q.plan.block];
  if (q.amountUsd < o.minUsd) return `The smallest amount is ${formatUsdTrim(o.minUsd)}.`;
  if (q.amountUsd > o.maxUsd) return limitText(o);
  if (q.left !== null && q.left <= 0) return EARN_COSTS_MORE;
  return null;
}

/** Why it can't be signed: a block (ending in Act is one), the rate after it still being read, or a Watch ending without the tick (D2). */
export function earnStop(q: EarnQuote, o: EarnOpen, confirmedRisk: boolean): string | null {
  const block = earnBlock(q, o);
  if (block) return block;
  if (q.left === null) return "One moment…";
  if (q.plan.extraConfirm && !confirmedRisk)
    return `Confirm you understand this puts your credit in ${STATUS_LABEL[q.plan.after]} first.`;
  return null;
}

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

const ticker = (symbol: string) => symbol.replace(/c$/, "");

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
    ...p.backing.map((b) => `${formatShares(b.shares)} ${ticker(b.symbol)} goes in use to back credit`),
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

// ── The batch ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Address = `0x${string}`;

const approveOf = (c: Call) => {
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
    return d.functionName === "approve" ? d.args : null;
  } catch {
    return null;
  }
};

const spokeCall = (c: Call | undefined) => {
  if (!c || !isAddressEqual(c.to, AAVE.SPOKE)) return null;
  try {
    return decodeFunctionData({ abi: spokeAbi, data: c.data });
  } catch {
    return null;
  }
};

const savingsCall = (c: Call | undefined) => {
  if (!c || !isAddressEqual(c.to, PROTOCOLS.AAVE_V3_POOL)) return null;
  try {
    return decodeFunctionData({ abi: aaveV3PoolAbi, data: c.data });
  } catch {
    return null;
  }
};

/**
 * Earn with stocks' batch, checked against the screen: first, only when the wallet can't be counted on for the network
 * fee, a savings withdrawal to the user (payFromCash, as every spend from cash); then for each stock the plan puts in
 * use, an exact approve to the spoke, the supply and "use as backing", all for the user; then the credit, once, as USDC
 * to the user; then an approve of exactly that credit to Aave V3's pool and its supply into savings for the user,
 * referral code 0, last. Nothing else: no swap, no transfer, no other savings call.
 */
export function assertEarn(
  user: Address,
  calls: Call[],
  review: { creditRaw: bigint; backing: readonly Backing[] },
): Call[] {
  if (review.creditRaw <= 0n) throw new Error("Blocked: Earn with stocks takes credit");
  if (calls.some((c) => c.value !== 0n)) throw new Error("Blocked: unexpected value");
  const w = savingsCall(calls[0]);
  const lead = w?.functionName === "withdraw" ? 1 : 0;
  if (lead && (!isAddressEqual(w!.args[0], USDC.address) || !isAddressEqual(w!.args[2], user)))
    throw new Error("Blocked: unexpected savings withdrawal");
  if (calls.length !== lead + review.backing.length * 3 + 3)
    throw new Error("Blocked: the batch differs from the screen");
  review.backing.forEach((b, k) => {
    const stock = EQUITIES.find((e) => isAddressEqual(e.address, b.stock.address));
    if (!stock || b.raw <= 0n) throw new Error("Blocked: unexpected backing");
    const id = BigInt(stock.reserveId);
    const [approve, supply, use] = calls.slice(lead + k * 3, lead + k * 3 + 3);
    const a = isAddressEqual(approve.to, stock.address) ? approveOf(approve) : null;
    if (!a || !isAddressEqual(a[0], AAVE.SPOKE) || a[1] !== b.raw)
      throw new Error("Blocked: the approval differs from the screen");
    const s = spokeCall(supply);
    if (s?.functionName !== "supply" || s.args[0] !== id || s.args[1] !== b.raw || !isAddressEqual(s.args[2], user)) {
      throw new Error("Blocked: the backing differs from the screen");
    }
    const u = spokeCall(use);
    if (
      u?.functionName !== "setUsingAsCollateral" ||
      u.args[0] !== id ||
      u.args[1] !== true ||
      !isAddressEqual(u.args[2], user)
    ) {
      throw new Error("Blocked: the backing differs from the screen");
    }
  });
  const [credit, approveSave, save] = calls.slice(-3);
  const creditCall = spokeCall(credit);
  if (
    creditCall?.functionName !== "borrow" ||
    creditCall.args[0] !== BigInt(USDC.reserveId) ||
    creditCall.args[1] !== review.creditRaw ||
    !isAddressEqual(creditCall.args[2], user)
  ) {
    throw new Error("Blocked: the credit differs from the screen");
  }
  const a = isAddressEqual(approveSave.to, USDC.address) ? approveOf(approveSave) : null;
  if (!a || !isAddressEqual(a[0], PROTOCOLS.AAVE_V3_POOL) || a[1] !== review.creditRaw)
    throw new Error("Blocked: the approval differs from the credit");
  const s = savingsCall(save);
  if (
    s?.functionName !== "supply" ||
    !isAddressEqual(s.args[0], USDC.address) ||
    s.args[1] !== review.creditRaw ||
    !isAddressEqual(s.args[2], user) ||
    s.args[3] !== 0
  ) {
    throw new Error("Blocked: what earns differs from the credit");
  }
  return calls;
}

/**
 * The batch: put the plan's backing in use and take the credit (lib/aave/tx.ts), then put exactly that credit where
 * the cash earns, for the user (buildAddSavingsCalls: an exact approve to Aave V3's pool and its supply). Cash pays the
 * network fee, from savings first when the wallet can't (payFromCash). The allowlist runs with the savings declared
 * (`saveTo`), and the whole batch is checked against the screen (assertEarn).
 */
export function buildEarnCalls(p: {
  user: Address;
  backing: readonly Backing[];
  creditRaw: bigint;
  cash: Cash;
}): Call[] {
  const backAndCredit = buildBackAndCreditCalls({ user: p.user, backing: [...p.backing], creditRaw: p.creditRaw });
  const calls = payFromCash(p.user, 0n, p.cash, [...backAndCredit, ...buildAddSavingsCalls(p.user, p.creditRaw)], {
    saveTo: p.user,
  });
  return assertEarn(p.user, calls, { creditRaw: p.creditRaw, backing: p.backing });
}

/**
 * What Activity shows while it confirms, as the receipt will read (lib/activity/decode.ts): the credit that came to the
 * cash, earning, then the backing put in use.
 */
export function earnActivity(plan: CreditPlan): ActivityItem[] {
  return [
    { kind: "earn", symbol: USDC.symbol, amount: toUsd(plan.creditRaw) },
    ...plan.backing.map((b) => ({
      kind: "supply" as const,
      symbol: b.stock.symbol,
      amount: Number(b.raw) / 10 ** b.stock.decimals,
    })),
  ];
}

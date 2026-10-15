import { decodeFunctionData, erc20Abi, isAddressEqual } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildLoanCalls, type Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { nyDay } from "@/lib/agents/next";
import type { AgentStatus } from "@/lib/agents/status";
import { cashRaw, feeBufferRaw, toUsd, type Cash } from "@/lib/cash";
import { CREDIT_BLOCKED, planCredit, shortNames, type Backing, type BackingOption, type CreditBlock, type CreditPlan, type CreditPosition } from "@/lib/creditBuy";
import { formatShares, formatUsdTrim, inWords } from "@/lib/formatting";
import { STATUS_LABEL } from "@/lib/risk/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/*
 * Earn with stocks (Adrian, 2026-10-15: "use your stock to add more cash to get yield"): put stocks to work as backing
 * and take credit as cash in one batch, so that cash earns the cash rate. Pure, so the offer, its caps and its words are
 * unit-tested and the dev gallery draws every state.
 *
 * Cash earns only through the Save job (there is no user-signed savings supply, lib/allowlist.ts): the credit lands in
 * the wallet and Save's next run moves it. So the offer needs earning on, and it is capped at what Save can move today.
 * Both rates are variable: the cash rate (Aave V3's USDC supply) and the credit's (the Hub's drawn rate with the
 * account's risk premium), each as an APY.
 */

// ── Rates ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rates on screen are in tenths of a point, rounded so the gap is never overstated: what the cash earns rounds down,
 * what the credit costs rounds up, and what's left is the difference of the two as shown, so the arithmetic on screen is
 * exact. The epsilon keeps a rate that is exactly on a tenth (4.1%) from rounding the wrong way in floating point.
 */
export const earnTenths = (apy: number) => Math.floor(apy * 1000 + 1e-6);
export const costTenths = (apy: number) => Math.ceil(apy * 1000 - 1e-6);
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
 * taking more can raise what the existing debt costs too. That rise is this credit's cost.
 */
export function marginalApy(p: { debtUsd: number; amountUsd: number; apyNow: number; apyAfter: number }): number {
  if (p.amountUsd <= 0) return p.apyAfter;
  return ((p.debtUsd + p.amountUsd) * p.apyAfter - p.debtUsd * p.apyNow) / p.amountUsd;
}

// ── What Save can move today ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What Save reads (GooseExecutor's SaveJob): what's left of its grant's daily USDC limit (the manager's period), the
 * wallet's USDC, the executor's keep-back, smallest save and saves a day (`amounts()`), and the account's saves today
 * (`accounts()`: the New York day of the last save and the count on it).
 */
export type SaveRoomInput = {
  leftRaw: bigint;
  walletRaw: bigint;
  keepBackRaw: bigint;
  minSaveRaw: bigint;
  savesDay: number;
  savesToday: number;
  maxSavesPerDay: number;
  nowSec: number;
};

/** Wallet USDC Save would sweep now: what's above the keep-back. */
const idleRaw = (r: SaveRoomInput) => (r.walletRaw > r.keepBackRaw ? r.walletRaw - r.keepBackRaw : 0n);

/**
 * Credit Save's next run moves in full, in USDC units: one run sweeps everything above the keep-back up to what's left
 * of today's limit, so the room is that limit less what already waits in the wallet; none once today's saves are used
 * up. The count resets on a new New York day, as SaveJob's `_savesToday` does.
 */
export function saveRoomRaw(r: SaveRoomInput): bigint {
  const today = r.savesDay === nyDay(r.nowSec) ? r.savesToday : 0;
  if (today >= r.maxSavesPerDay) return 0n;
  const idle = idleRaw(r);
  return r.leftRaw > idle ? r.leftRaw - idle : 0n;
}

/** The smallest amount: $1, or more when Save's smallest save is more than what already waits in the wallet. */
export function minEarnUsd(r: SaveRoomInput): number {
  const idle = idleRaw(r);
  const short = r.minSaveRaw > idle ? Math.ceil(toUsd(r.minSaveRaw - idle)) : 0;
  return Math.max(1, short);
}

// ── The offer ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why the card offers nothing, in its one line. */
export const EARN_CLOSED = {
  off: "Your cash isn’t earning yet. Start earning first.",
  starting: "Your cash starts earning in a moment. Then Earn with stocks opens.",
  "no-stocks": "Earn with stocks needs stocks that can back credit.",
  "costs-more": "Credit costs more than your cash earns right now.",
  paused: "New credit is paused right now. Try again later.",
  today: "Your cash can’t start earning on more today. Try again tomorrow.",
  credit: "Your stocks can’t back more credit right now.",
  fee: CREDIT_BLOCKED.fee,
} as const;
export type EarnClosed = keyof typeof EARN_CLOSED;

/** What binds the most: what Save can move today, or the credit the stocks can back (and the USDC available). */
export type EarnLimit = "today" | "credit";

export type EarnOffer =
  | { kind: "hidden" }
  | { kind: "loading" }
  /** Nothing to offer, and why; with the rates when they are the reason. */
  | { kind: "closed"; why: EarnClosed; text: string; rates?: EarnRates }
  | { kind: "offer"; rates: EarnRates; maxUsd: number; maxSafeUsd: number; minUsd: number; limitedBy: EarnLimit };

export type EarnInput = {
  /** Earning (the Save job): useCashSetup's `save`. */
  save: AgentStatus;
  /** What the cash earns and what credit costs now, each an APY. */
  cashApy: number;
  creditApy: number;
  position: CreditPosition;
  /** backingOptions on the live collateral factors; undefined while they load. */
  options: BackingOption[] | undefined;
  cash: Cash;
  /** What Save can move today; null while it loads. */
  room: SaveRoomInput | null;
  now?: Date;
};

const closed = (why: EarnClosed, rates?: EarnRates): EarnOffer => ({ kind: "closed", why, text: EARN_CLOSED[why], ...(rates ? { rates } : {}) });

/**
 * Whether the Cash sheet offers Earn with stocks, and up to how much. The first rule that matches wins:
 * no executor (no card); loading; earning off or starting; no stocks that can back credit; credit costing as much as the
 * cash earns or more (as shown, in tenths); new credit paused; nothing left today (Save's room) or nothing the stocks can
 * back (99.5% of the credit limit, as /use-credit, and the USDC available); no cash for the network fee.
 */
export function earnOffer(i: EarnInput): EarnOffer {
  if (i.save === "unconfigured") return { kind: "hidden" };
  if (i.save === "loading") return { kind: "loading" };
  if (i.save === "off" || i.save === "starting") return closed(i.save);
  if (!i.options || !i.room) return { kind: "loading" };
  if (i.options.length === 0 && i.position.collateralUsd === 0) return closed("no-stocks");
  const rates = earnRates(i.cashApy, i.creditApy);
  if (rates.left <= 0) return closed("costs-more", rates);
  if (i.position.borrowPaused) return closed("paused");

  const plan0 = planCredit({ position: i.position, options: i.options, creditRaw: 0n, cash: i.cash, now: i.now });
  const creditUsd = Math.min(plan0.maxUsd, i.position.usdcLiquidity);
  const roomUsd = toUsd(saveRoomRaw(i.room));
  const limitedBy: EarnLimit = roomUsd < creditUsd ? "today" : "credit";
  const maxUsd = Math.floor(Math.min(creditUsd, roomUsd));
  const minUsd = minEarnUsd(i.room);
  if (maxUsd < minUsd) return closed(limitedBy);
  if (cashRaw(i.cash) < feeBufferRaw) return closed("fee");
  return { kind: "offer", rates, maxUsd, maxSafeUsd: plan0.maxSafeUsd, minUsd, limitedBy };
}

export type EarnOpen = Extract<EarnOffer, { kind: "offer" }>;

/** The cap in words: "Up to $1,000 today, so all of it starts earning." or "Up to $1,000.". */
const limitText = (o: EarnOpen) =>
  o.limitedBy === "today" ? `Up to ${formatUsdTrim(o.maxUsd)} today, so all of it starts earning.` : `Up to ${formatUsdTrim(o.maxUsd)}.`;

/** The amount field's hint: the cap, and for the credit cap the Safe line when it's lower. */
export function earnHint(o: EarnOpen): string {
  const safe = Math.floor(o.maxSafeUsd);
  return o.limitedBy === "credit" && safe < o.maxUsd ? `${limitText(o)} Stay under ${formatUsdTrim(safe)} to stay Safe.` : limitText(o);
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
  const plan = planCredit({ position: p.position, options: p.options, creditRaw: p.creditRaw, cash: p.cash, now: p.now });
  const amountUsd = toUsd(p.creditRaw);
  if (p.creditApyAfter === null || amountUsd <= 0) return { plan, amountUsd, cost: null, left: null, leftUsdYear: null };
  const cost = costTenths(marginalApy({ debtUsd: p.position.debtUsd, amountUsd, apyNow: p.creditApyNow, apyAfter: p.creditApyAfter }));
  const left = p.offer.rates.earn - cost;
  return { plan, amountUsd, cost, left, leftUsdYear: Math.max(0, Math.floor((left / 1000) * amountUsd)) };
}

/** The plan's blocks in the Cash sheet's own words: no protocol names. */
export const EARN_BLOCKED: Record<CreditBlock, string> = {
  paused: EARN_CLOSED.paused,
  "no-liquidity": "There isn’t enough credit available right now. Try a smaller amount.",
  "too-much": "That’s more credit than your stocks can back right now. Try a smaller amount.",
  fee: CREDIT_BLOCKED.fee,
};

export const EARN_COSTS_MORE = "At this amount, credit costs more than your cash earns right now.";

/** Why this amount can't go ahead, in the red line under it; null when it can (the risk tick aside). */
export function earnBlock(q: EarnQuote, o: EarnOpen): string | null {
  if (q.plan.block) return EARN_BLOCKED[q.plan.block];
  if (q.amountUsd < o.minUsd) return `The smallest amount is ${formatUsdTrim(o.minUsd)}.`;
  if (q.amountUsd > o.maxUsd) return limitText(o);
  if (q.left !== null && q.left <= 0) return EARN_COSTS_MORE;
  return null;
}

/** Why it can't be signed: a block, the rate after it still being read, or a Watch/Act ending without the tick (D2). */
export function earnStop(q: EarnQuote, o: EarnOpen, confirmedRisk: boolean): string | null {
  const block = earnBlock(q, o);
  if (block) return block;
  if (q.left === null) return "One moment…";
  if (q.plan.extraConfirm && !confirmedRisk) return `Confirm you understand this puts your credit in ${STATUS_LABEL[q.plan.after]} first.`;
  return null;
}

// ── Words around the button ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one risk line, from what Protect does now: repay from the cash, and sell a little backing stock when that's on
 * (decision 5). "Protect is off" only when it is.
 */
export function earnRiskLine(p: { names: readonly string[]; protect: AgentStatus; sell: AgentStatus }): string {
  const one = p.names.length === 1 ? p.names[0] : null;
  const falls = one ? `If ${one} falls` : "If your stocks fall";
  if (p.protect === "on") {
    return p.sell === "on"
      ? `${falls}, you can repay from your cash, or Protect repays from it, then sells a little ${one ?? "of them"} to keep you Safe.`
      : `${falls}, you can repay from your cash, or Protect repays from it. Protect won’t sell your ${one ? "stock" : "stocks"}.`;
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
    `${formatUsdTrim(p.amountUsd)} of credit comes to your cash, where it starts earning soon`,
  ];
  // What's owed rounds up, as on Home: never shown as less than it is.
  return (
    `In one go: ${inWords(moves)}. You’ll owe ${formatUsdTrim(Math.ceil(p.owedUsd))}, backed by ${shortNames(p.backedBy)}. ` +
    `${p.risk} Tokenized stocks track the share price; they are not company shares or voting rights.`
  );
}

/** The risk tick (D2), when it ends in Watch or Act. */
export const earnTick = (after: CreditPlan["after"]) =>
  `I understand this puts my credit in ${STATUS_LABEL[after]}. If my stocks fall, part of them can be sold to repay what I owe.`;

export const earnDone = (amountUsd: number) => `${formatUsdTrim(amountUsd)} is in your cash. It starts earning soon.`;

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

/**
 * Earn with stocks' batch, checked against the screen: for each stock the plan puts in use, an exact approve to the
 * spoke, the supply and "use as backing", all for the user; then the credit, once, as USDC to the user, last. Nothing
 * else: no swap, no transfer, no savings call (Save moves the credit, under the hood).
 */
export function assertEarn(user: Address, calls: Call[], review: { creditRaw: bigint; backing: readonly Backing[] }): Call[] {
  if (review.creditRaw <= 0n) throw new Error("Blocked: Earn with stocks takes credit");
  if (calls.length !== review.backing.length * 3 + 1) throw new Error("Blocked: the batch differs from the screen");
  if (calls.some((c) => c.value !== 0n)) throw new Error("Blocked: unexpected value");
  review.backing.forEach((b, k) => {
    const stock = EQUITIES.find((e) => isAddressEqual(e.address, b.stock.address));
    if (!stock || b.raw <= 0n) throw new Error("Blocked: unexpected backing");
    const id = BigInt(stock.reserveId);
    const [approve, supply, use] = calls.slice(k * 3, k * 3 + 3);
    const a = isAddressEqual(approve.to, stock.address) ? approveOf(approve) : null;
    if (!a || !isAddressEqual(a[0], AAVE.SPOKE) || a[1] !== b.raw) throw new Error("Blocked: the approval differs from the screen");
    const s = spokeCall(supply);
    if (s?.functionName !== "supply" || s.args[0] !== id || s.args[1] !== b.raw || !isAddressEqual(s.args[2], user)) {
      throw new Error("Blocked: the backing differs from the screen");
    }
    const u = spokeCall(use);
    if (u?.functionName !== "setUsingAsCollateral" || u.args[0] !== id || u.args[1] !== true || !isAddressEqual(u.args[2], user)) {
      throw new Error("Blocked: the backing differs from the screen");
    }
  });
  const borrow = spokeCall(calls.at(-1));
  if (
    borrow?.functionName !== "borrow" ||
    borrow.args[0] !== BigInt(USDC.reserveId) ||
    borrow.args[1] !== review.creditRaw ||
    !isAddressEqual(borrow.args[2], user)
  ) {
    throw new Error("Blocked: the credit differs from the screen");
  }
  return calls;
}

/** The batch: put the plan's backing in use and take the credit to the user's own account (lib/aave/tx.ts), checked. */
export function buildEarnCalls(p: { user: Address; backing: readonly Backing[]; creditRaw: bigint }): Call[] {
  const calls = buildLoanCalls({ user: p.user, locks: [...p.backing], borrowRaw: p.creditRaw });
  return assertEarn(p.user, calls, { creditRaw: p.creditRaw, backing: p.backing });
}

/** What Activity shows while it confirms: the backing put in use and the credit that came to the cash. */
export function earnActivity(plan: CreditPlan): ActivityItem[] {
  return [
    ...plan.backing.map((b) => ({ kind: "supply" as const, symbol: b.stock.symbol, amount: Number(b.raw) / 10 ** b.stock.decimals })),
    { kind: "borrow", symbol: USDC.symbol, amount: toUsd(plan.creditRaw) },
  ];
}

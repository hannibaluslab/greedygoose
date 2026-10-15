import { decodeFunctionData, erc20Abi, isAddressEqual, parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { autoFill, combinedLoan, fillRaw, type LockLine } from "@/lib/aave/loan";
import { buildLoanCalls, type Call } from "@/lib/aave/tx";
import { cashRaw, feeBufferRaw, maxSpendRaw, payFromCash, toUsd, type Cash } from "@/lib/cash";
import { formatUsd } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import type { ActivityItem } from "@/lib/activity/decode";
import { STATUS_LABEL, needsExtraConfirm, statusFor, type Status } from "@/lib/risk/status";
import { BUY_LIMITS, buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;

/** A free holding that can back credit, valued at Aave's price. */
export type BackingOption = { stock: ReserveAsset; freeRaw: bigint; freeUsd: number; cf: number };
/** Free stock put in use as backing, in the same batch. */
export type Backing = { stock: ReserveAsset; raw: bigint };
/**
 * Credit Buy goes backing first (Adrian, 2026-10-15): the holding picked to back it and exactly how much of it goes in
 * use. No option, or 0n, puts nothing new in use: only what already backs credit counts.
 */
export type BackingPick = { option: BackingOption | null; raw: bigint };
/**
 * What a Credit Buy batch may not go past (assertCreditBuy): each backing's free shares, as the screen read them, and
 * the most credit that backing and what already backs credit allow (99.5% of Aave's limit, as /use-credit).
 */
export type CreditLimit = { maxCreditRaw: bigint; freeRaw: Readonly<Record<string, bigint>> };

/** Free holdings that can back credit, as /use-credit lists them: a collateral factor, not paused or frozen. */
export function backingOptions(
  holdings: readonly { symbol: string; freeRaw: bigint; freeUsd: number; paused: boolean; frozen: boolean }[],
  cfs: Record<string, number>,
): BackingOption[] {
  return holdings.flatMap((h) => {
    const stock = EQUITIES.find((e) => e.symbol === h.symbol);
    const cf = cfs[h.symbol] ?? 0;
    return stock && h.freeUsd >= 0.01 && cf > 0 && !h.paused && !h.frozen ? [{ stock, freeRaw: h.freeRaw, freeUsd: h.freeUsd, cf }] : [];
  });
}

/**
 * What backs credit once a Credit Buy lands: the holdings `adding` puts in use and every holding already in use,
 * `lead` first (the one picked to back it) when it is among them.
 */
export function backers<H extends { symbol: string; lockedRaw: bigint }>(holdings: readonly H[], adding: readonly string[], lead?: string): H[] {
  const backs = holdings.filter((h) => adding.includes(h.symbol) || h.lockedRaw > 0n);
  const rank = (h: H) => (h.symbol === lead ? 0 : adding.includes(h.symbol) ? 1 : 2);
  return backs.sort((a, b) => rank(a) - rank(b));
}

/** Names for one short line: "NVIDIA", "NVIDIA and Tesla", "NVIDIA and 3 more". */
export function shortNames(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more`;
}

/** The position fields the plan reads (usePosition's data has them all). */
export type CreditPosition = {
  collateralUsd: number;
  avgCf: number;
  debtUsd: number;
  healthFactor: number | null;
  usdcLiquidity: number;
  borrowPaused: boolean;
};

export type CreditBlock = "paused" | "no-liquidity" | "over-free" | "too-much" | "fee";

export const CREDIT_BLOCKED: Record<CreditBlock, string> = {
  paused: "Aave isn’t giving new USDC credit right now.",
  "no-liquidity": "Aave doesn’t have enough USDC for this right now. Try a smaller amount.",
  "over-free": "That’s more than you have free to put in use. Try a smaller amount.",
  "too-much": "That’s more credit than your stocks can back right now. Try a smaller amount.",
  fee: `The network fee is paid from your cash. Top up ${formatUsd(CASH.feeBufferUsd)} first.`,
};

export type CreditPlan = {
  creditRaw: bigint;
  /** Free stock to put in use first; empty when what already backs credit covers it. */
  backing: (Backing & { usd: number })[];
  /** What the batch is checked against: this backing's free shares and the most credit it allows (assertCreditBuy). */
  limit: CreditLimit;
  before: Status;
  after: Status;
  hfAfter: number;
  /** It ends in Watch or Act, so the screen needs the risk tick (D2). */
  extraConfirm: boolean;
  /**
   * Most credit with every option in use (or, with an explicit pick, with that pick in use): staying Safe, and the MAX
   * (99.5% of Aave's limit, as /use-credit).
   */
  maxSafeUsd: number;
  maxUsd: number;
  /** Markets are closed: still allowed (Aave allows it), and the screen must say the price may move when they reopen (CLAUDE.md › Market hours). */
  priceMayMove: boolean;
  /** Why it can't go ahead. */
  block?: CreditBlock;
};

const loanOf = (pos: CreditPosition) => ({ collateralUsd: pos.collateralUsd, avgCf: pos.avgCf, debtUsd: pos.debtUsd, liquidityUsd: pos.usdcLiquidity });
const lineOf = (o: BackingOption, usd: number) => ({ key: o.stock.symbol, usd, cf: o.cf, freeUsd: o.freeUsd });

/**
 * The most credit with every option in use, on Leo's combinedLoan: the MAX (99.5% of Aave's limit, as /use-credit) and
 * the most that stays Safe. Net of what's owed, within what Aave can lend.
 */
function creditRoom(pos: CreditPosition, options: readonly BackingOption[]): { maxUsd: number; maxSafeUsd: number } {
  return roomWith(pos, options.map((o) => lineOf(o, o.freeUsd)));
}

/** combinedLoan's room with these lines in use (no credit taken yet), floored to the cent. */
function roomWith(pos: CreditPosition, lines: LockLine[]): { maxUsd: number; maxSafeUsd: number } {
  const all = combinedLoan({ ...loanOf(pos), borrowUsd: 0, locks: lines });
  return { maxUsd: Math.floor(all.maxAave * 0.995 * 100) / 100, maxSafeUsd: Math.floor(all.maxSafe * 100) / 100 };
}

/** The value of `raw` of a free holding, at the price its free value was read at. */
const usdOf = (o: BackingOption, raw: bigint) => (o.freeRaw > 0n ? (o.freeUsd * Number(raw)) / Number(o.freeRaw) : 0);
const usdcRaw = (usd: number) => parseUnits(Math.max(0, usd).toFixed(USDC.decimals), USDC.decimals);

/**
 * "How much to put in use", typed in dollars, in raw units of the holding: in proportion to its free value. Within half
 * a cent of all of it is all of it (`freeRaw`, so no dust is left behind); more than it stays more, for the plan to
 * block ("over-free"). MAX passes the free shares straight through, not dollars.
 */
export function backingRaw(option: BackingOption, usd: number): bigint {
  if (!(usd > 0) || option.freeRaw <= 0n || option.freeUsd <= 0) return 0n;
  if (Math.abs(usd - option.freeUsd) < 0.005) return option.freeRaw;
  return (option.freeRaw * BigInt(Math.round(usd * 1e6))) / BigInt(Math.max(1, Math.round(option.freeUsd * 1e6)));
}

/**
 * The most one Credit Buy can use with all of `option` in use and what already backs credit (planCredit's MAX with that
 * one option: step 2's MAX on it). Without `option`, the room on what already backs credit alone (step 1's "Already
 * backs credit" row).
 */
export function creditWith(position: CreditPosition, option?: BackingOption): number {
  return creditRoom(position, option ? [option] : []).maxUsd;
}

/**
 * The holding step 1 ("Back it with") picks until Sam picks another: the one a Credit Buy can use the most with (ties:
 * the most free stock). Its figure is Invest's buying power in credit (creditAvailable) and step 2's MAX on it.
 */
export function bestBacking(position: CreditPosition, options: readonly BackingOption[]): { option: BackingOption; usd: number } | null {
  let best: { option: BackingOption; usd: number } | null = null;
  for (const option of options) {
    const usd = creditWith(position, option);
    if (!best || usd > best.usd || (usd === best.usd && option.freeUsd > best.option.freeUsd)) best = { option, usd };
  }
  return best;
}

/**
 * What backs `creditRaw` of credit and the status it ends in, on Leo's loan maths.
 *
 * With `backing` (Credit Buy, backing first): exactly that pick goes in use, and the room is what it and what already
 * backs credit allow (99.5% of Aave's limit). More than its free shares is blocked ("over-free"); 0n uses only what
 * already backs credit.
 *
 * Without it (decision 1, Earn with stocks): what already backs credit counts first; autoFill tops up from `options`
 * (highest collateral factor first) so the position starts Safe, with FILL_MARGIN on top. Past Safe, everything in
 * `options` goes in and the screen asks for the risk tick.
 *
 * Plan only: the batch is checked against `limit` and simulated before JAW's sheet.
 */
export function planCredit(
  p: { position: CreditPosition; creditRaw: bigint; cash: Cash; now?: Date } & (
    | { options: readonly BackingOption[]; backing?: undefined }
    | { backing: BackingPick; options?: undefined }
  ),
): CreditPlan {
  const pos = p.position;
  const creditUsd = toUsd(p.creditRaw);
  const loan = loanOf(pos);

  let chosen: { option: BackingOption; raw: bigint; usd: number }[];
  let room: { maxUsd: number; maxSafeUsd: number };
  let overFree = false;
  if (p.backing) {
    const { option, raw: want } = p.backing;
    overFree = want > (option?.freeRaw ?? 0n);
    const raw = option ? (want < option.freeRaw ? want : option.freeRaw) : 0n;
    chosen = option && raw > 0n ? [{ option, raw, usd: usdOf(option, raw) }] : [];
    room = roomWith(pos, chosen.map((c) => lineOf(c.option, c.usd)));
  } else {
    const options = p.options;
    const fill = autoFill({ ...loan, borrowUsd: creditUsd, lines: options.map((o) => lineOf(o, 0)) });
    chosen = options.flatMap((o) => {
      const raw = fillRaw(o.freeRaw, o.freeUsd, fill[o.stock.symbol]);
      return raw > 0n ? [{ option: o, raw, usd: usdOf(o, raw) }] : [];
    });
    room = creditRoom(pos, options);
  }
  const lines = chosen.map((c) => lineOf(c.option, c.usd));
  const calc = combinedLoan({ ...loan, borrowUsd: creditUsd, locks: lines });
  const { maxUsd, maxSafeUsd } = room;
  const after = statusFor(pos.debtUsd + creditUsd > 0 ? calc.hfAfter : null);
  // The batch's own ceiling: the room with exactly the backing it puts in use (for an explicit pick, maxUsd itself).
  const limit: CreditLimit = {
    maxCreditRaw: usdcRaw(p.backing ? maxUsd : roomWith(pos, lines).maxUsd),
    freeRaw: Object.fromEntries(chosen.map((c) => [c.option.stock.symbol, c.option.freeRaw])),
  };

  let block: CreditBlock | undefined;
  if (pos.borrowPaused) block = "paused";
  else if (creditUsd > pos.usdcLiquidity) block = "no-liquidity";
  else if (overFree) block = "over-free";
  else if (creditUsd > maxUsd) block = "too-much";
  else if (cashRaw(p.cash) < feeBufferRaw) block = "fee";

  return {
    creditRaw: p.creditRaw,
    backing: chosen.map((c) => ({ stock: c.option.stock, raw: c.raw, usd: c.usd })),
    limit,
    before: statusFor(pos.healthFactor),
    after,
    hfAfter: calc.hfAfter,
    extraConfirm: creditUsd > 0 && needsExtraConfirm(after),
    maxSafeUsd,
    maxUsd,
    priceMayMove: !marketState(p.now).open,
    block,
  };
}

/** Why a Credit Buy can use nothing right now (F2-3's zero state, shown at step 1). */
export type NoCredit = "no-stocks" | "cant-back" | "all-in-use" | "paused" | "no-liquidity";

/** F2-3's line under "$0", first half: why. */
export const NO_CREDIT: Record<NoCredit, string> = {
  "no-stocks": "Credit comes from the stocks you own.",
  "cant-back": "Your stocks can’t back credit right now.",
  "all-in-use": "Your stocks already back what you owe. Repay some to use more.",
  paused: "New credit is paused right now.",
  "no-liquidity": "There’s no credit to give out right now.",
};

/**
 * F2-3's whole line under "$0": why, then that cash still buys (a stock tapped there opens its Buy step with cash), or,
 * with too little cash for the smallest buy and its network fee, to top up first.
 */
export function noCreditLine(why: NoCredit, canPayCash: boolean): string {
  const then =
    why === "no-stocks"
      ? canPayCash ? "Buy one with cash first." : "Top up, then buy one with cash."
      : canPayCash ? "You can still buy with cash." : "Top up to buy with cash.";
  return `${NO_CREDIT[why]} ${then}`;
}

/** F2-3's line under the number when there is credit to use. */
export const CREDIT_FROM = "In credit, backed by the stocks you own.";
/** …and when there's credit but not the network fee: cash pays it (D4), and F2-5 would block every amount ("fee"). */
export const FEE_FIRST = `Add ${formatUsd(CASH.feeBufferUsd)} to your cash for the network fee first.`;

export type CreditAvailable = {
  /** The most one Credit Buy can use right now; 0 with `why`. */
  usd: number;
  why?: NoCredit;
  /** The plain line under the number. */
  line: string;
};

/**
 * The most one Credit Buy can use right now, with the best holding all in use (Invest's buying power), and whether it
 * can use anything at all (Credit Buy's step 1 says why at $0). A Credit Buy is backed by one free holding plus what
 * already backs credit, so this is the best of the per-holding figures (bestBacking, the one step 1 picks first), or
 * the room on what already backs credit when nothing free can back it. Net of what's owed and capped by what Aave
 * can lend (combinedLoan). Under the minimum buy, or while new credit is paused, it is $0 with the reason. With credit
 * but less cash than the network fee, the number stays and the line asks for the fee first.
 * `options` are the ones step 1 lists; `holdsStock` is whether the account owns any stock, free or in use.
 */
export function creditAvailable(p: { position: CreditPosition; options: readonly BackingOption[]; cash: Cash; holdsStock: boolean }): CreditAvailable {
  const usd = Math.max(creditWith(p.position), bestBacking(p.position, p.options)?.usd ?? 0);
  const why = ((): NoCredit | undefined => {
    if (!p.holdsStock) return "no-stocks";
    if (p.position.borrowPaused) return "paused";
    if (usd >= BUY_LIMITS.minUsd) return undefined;
    if (p.position.usdcLiquidity < BUY_LIMITS.minUsd) return "no-liquidity";
    return p.options.length === 0 && p.position.collateralUsd <= 0 ? "cant-back" : "all-in-use";
  })();
  if (why) return { usd: 0, why, line: noCreditLine(why, toUsd(maxSpendRaw(p.cash)) >= BUY_LIMITS.minUsd) };
  return { usd, line: cashRaw(p.cash) < feeBufferRaw ? FEE_FIRST : CREDIT_FROM };
}

/** Why a Credit Buy on screen can't be signed: a block, or a Watch/Act ending without the extra confirmation (D2). */
export function creditBuyStop(plan: CreditPlan, confirmedRisk: boolean): string | null {
  if (plan.block) return CREDIT_BLOCKED[plan.block];
  if (plan.extraConfirm && !confirmedRisk) return `Confirm you understand this puts your credit in ${STATUS_LABEL[plan.after]} first.`;
  return null;
}

/** What Activity shows while it confirms: the backing put in use, the credit taken and the buy. */
export function creditBuyActivity(p: { stock: ReserveAsset; quote: BuyQuote; plan: CreditPlan }): ActivityItem[] {
  return [
    ...p.plan.backing.map((b) => ({ kind: "supply" as const, symbol: b.stock.symbol, amount: Number(b.raw) / 10 ** b.stock.decimals })),
    { kind: "borrow", symbol: USDC.symbol, amount: toUsd(p.plan.creditRaw) },
    { kind: "buy", symbol: p.stock.symbol, amount: Number(p.quote.amountOut) / 10 ** p.stock.decimals, paidUsd: toUsd(p.quote.amountIn) },
  ];
}

/**
 * Decision 1 ("That's more than your cash"): cash pays what it can, all of it less the network-fee
 * buffer, and credit covers the other part. `creditRaw` is 0 when cash covers the buy.
 */
export function splitCash(amountRaw: bigint, cash: Cash): { cashRaw: bigint; creditRaw: bigint } {
  const max = maxSpendRaw(cash);
  const fromCash = amountRaw < max ? amountRaw : max;
  return { cashRaw: fromCash, creditRaw: amountRaw - fromCash };
}

/**
 * Credit Buy in one batch (plan item 3): [savings withdrawal] → [put backing in use] → take credit
 * → approve → swap, so the credit never sits in the wallet. The swap spends the credit plus what cash
 * pays (decision 1; 0 for a plain Credit Buy). Cash pays the network fee, from savings when the wallet
 * can't (payFromCash). Every call passes the allowlist with the user pinned, and the whole batch is
 * checked against the screen (assertCreditBuy).
 */
export function buildCreditBuyCalls(p: {
  user: Address;
  stock: ReserveAsset;
  quote: BuyQuote;
  creditRaw: bigint;
  /** Exactly what goes in use (the plan's backing: the typed amount on Credit Buy, autoFill's for decision 1). */
  backing: Backing[];
  /** The plan's limit: the free shares it read and the most credit that backing allows. */
  limit: CreditLimit;
  cash: Cash;
  nowSec?: number;
}): Call[] {
  const fromCash = p.quote.amountIn - p.creditRaw;
  if (p.creditRaw <= 0n || fromCash < 0n) throw new Error("Credit must be part of the buy");
  const spend = [...buildLoanCalls({ user: p.user, locks: p.backing, borrowRaw: p.creditRaw }), ...buildBuyCalls(p)];
  return assertCreditBuy(p.user, payFromCash(p.user, fromCash, p.cash, spend), {
    stock: p.stock,
    creditRaw: p.creditRaw,
    cashRaw: fromCash,
    backing: p.backing.filter((b) => b.raw > 0n),
    limit: p.limit,
  });
}

const decodeApprove = (c: Call) => {
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
    return d.functionName === "approve" ? d.args : null;
  } catch {
    return null;
  }
};

const spokeCall = (c: Call) => {
  if (!isAddressEqual(c.to, AAVE.SPOKE)) return null;
  try {
    return decodeFunctionData({ abi: spokeAbi, data: c.data });
  } catch {
    return null;
  }
};

/**
 * The Credit Buy checks on the finished batch, against what the screen shows: the stock put in use is exactly
 * `backing`, each for the user, approved exactly to the spoke, never more than its free shares and before the credit;
 * credit is taken once, as USDC to the user, for exactly `creditRaw` and no more than that backing allows; the batch
 * ends with an exact approve and one swap into `stock` (one of the 7), paid to the user, spending exactly the credit
 * plus `cashRaw`.
 */
export function assertCreditBuy(
  user: Address,
  calls: Call[],
  review: { stock: ReserveAsset; creditRaw: bigint; cashRaw: bigint; backing: readonly Backing[]; limit: CreditLimit },
): Call[] {
  const borrows = calls.flatMap((c, i) => {
    const d = spokeCall(c);
    return d?.functionName === "borrow" ? [{ i, args: d.args }] : [];
  });
  const supplies = calls.flatMap((c, i) => {
    const d = spokeCall(c);
    return d?.functionName === "supply" ? [{ i, args: d.args }] : [];
  });
  const swaps = calls.flatMap((c, i) => {
    const s = swapOf(c);
    return s ? [{ i, ...s }] : [];
  });
  if (borrows.length !== 1 || swaps.length !== 1) throw new Error("Blocked: a Credit Buy takes credit once and swaps once");
  const [borrow] = borrows;
  const [swap] = swaps;
  if (swap.i !== calls.length - 1 || borrow.i > swap.i) throw new Error("Blocked: the swap must come last, after the credit");
  const [reserveId, amount, onBehalfOf] = borrow.args;
  if (reserveId !== BigInt(USDC.reserveId) || amount !== review.creditRaw || !isAddressEqual(onBehalfOf, user)) {
    throw new Error("Blocked: the credit differs from the review");
  }
  if (review.creditRaw > review.limit.maxCreditRaw) throw new Error("Blocked: more credit than the backing allows");

  if (supplies.length !== review.backing.length) throw new Error("Blocked: the backing differs from the review");
  review.backing.forEach((b, n) => {
    const s = supplies[n];
    const [id, raw, onBehalf] = s.args;
    const free = review.limit.freeRaw[b.stock.symbol];
    if (id !== BigInt(b.stock.reserveId) || raw !== b.raw || !isAddressEqual(onBehalf, user) || s.i > borrow.i) {
      throw new Error("Blocked: the backing differs from the review");
    }
    if (free === undefined || b.raw > free) throw new Error("Blocked: more backing than the free shares");
    const approve = calls[s.i - 1];
    const a = approve && isAddressEqual(approve.to, b.stock.address) ? decodeApprove(approve) : null;
    if (!a || !isAddressEqual(a[0], AAVE.SPOKE) || a[1] !== b.raw) throw new Error("Blocked: the backing's approval differs");
  });

  const { tokenIn, tokenOut, recipient, amountIn } = swap.params;
  const isStock = EQUITIES.some((e) => isAddressEqual(e.address, tokenOut));
  if (
    !isStock ||
    !isAddressEqual(tokenOut, review.stock.address) ||
    !isAddressEqual(tokenIn, USDC.address) ||
    !isAddressEqual(recipient, user) ||
    amountIn !== review.creditRaw + review.cashRaw
  ) {
    throw new Error("Blocked: the swap differs from the review");
  }
  const approve = calls[swap.i - 1];
  const a = approve && isAddressEqual(approve.to, USDC.address) ? decodeApprove(approve) : null;
  if (!a || !isAddressEqual(a[0], swap.router) || a[1] !== amountIn) {
    throw new Error("Blocked: the approval differs from the swap");
  }
  return calls;
}

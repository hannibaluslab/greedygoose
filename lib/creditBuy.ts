import { decodeFunctionData, erc20Abi, isAddressEqual } from "viem";
import { CASH } from "@/config/risk";
import { swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { autoFill, combinedLoan, fillRaw } from "@/lib/aave/loan";
import { buildLoanCalls, type Call } from "@/lib/aave/tx";
import { cashRaw, feeBufferRaw, maxSpendRaw, payFromCash, toUsd, type Cash } from "@/lib/cash";
import { formatUsd } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import type { ActivityItem } from "@/lib/activity/decode";
import { STATUS_LABEL, needsExtraConfirm, statusFor, type Status } from "@/lib/risk/status";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;

/** A free holding that can back credit, valued at Aave's price. */
export type BackingOption = { stock: ReserveAsset; freeRaw: bigint; freeUsd: number; cf: number };
/** Free stock put in use as backing, in the same batch. */
export type Backing = { stock: ReserveAsset; raw: bigint };

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

export type CreditBlock = "paused" | "no-liquidity" | "too-much" | "fee";

export const CREDIT_BLOCKED: Record<CreditBlock, string> = {
  paused: "Aave isn’t giving new USDC credit right now.",
  "no-liquidity": "Aave doesn’t have enough USDC for this right now. Try a smaller amount.",
  "too-much": "That’s more credit than your stocks can back right now. Try a smaller amount.",
  fee: `The network fee is paid from your cash. Top up ${formatUsd(CASH.feeBufferUsd)} first.`,
};

export type CreditPlan = {
  creditRaw: bigint;
  /** Free stock to put in use first; empty when what already backs credit covers it. */
  backing: (Backing & { usd: number })[];
  before: Status;
  after: Status;
  hfAfter: number;
  /** It ends in Watch or Act, so the screen needs the risk tick (D2). */
  extraConfirm: boolean;
  /** Most credit with every option in use: staying Safe, and the MAX (99.5% of Aave's limit, as /use-credit). */
  maxSafeUsd: number;
  maxUsd: number;
  /** Markets are closed: still allowed (Aave allows it), and the screen must say the price may move when they reopen (CLAUDE.md › Market hours). */
  priceMayMove: boolean;
  /** Why it can't go ahead. */
  block?: CreditBlock;
};

/**
 * What backs `creditRaw` of credit and the status it ends in, on Leo's loan maths. What already
 * backs credit counts first; autoFill tops up from `options` (highest collateral factor first) so
 * the position starts Safe, with FILL_MARGIN on top. Past Safe, everything in `options` goes in
 * and the screen asks for the risk tick. Plan only: the batch is simulated before JAW's sheet.
 */
export function planCredit(p: { position: CreditPosition; options: BackingOption[]; creditRaw: bigint; cash: Cash; now?: Date }): CreditPlan {
  const { position: pos, options } = p;
  const creditUsd = toUsd(p.creditRaw);
  const loan = { collateralUsd: pos.collateralUsd, avgCf: pos.avgCf, debtUsd: pos.debtUsd, liquidityUsd: pos.usdcLiquidity };
  const line = (o: BackingOption, usd: number) => ({ key: o.stock.symbol, usd, cf: o.cf, freeUsd: o.freeUsd });

  const fill = autoFill({ ...loan, borrowUsd: creditUsd, lines: options.map((o) => line(o, 0)) });
  const chosen = options.flatMap((o) => {
    const raw = fillRaw(o.freeRaw, o.freeUsd, fill[o.stock.symbol]);
    return raw > 0n ? [{ option: o, raw, usd: (o.freeUsd * Number(raw)) / Number(o.freeRaw) }] : [];
  });
  const calc = combinedLoan({ ...loan, borrowUsd: creditUsd, locks: chosen.map((c) => line(c.option, c.usd)) });
  const all = combinedLoan({ ...loan, borrowUsd: 0, locks: options.map((o) => line(o, o.freeUsd)) });
  const maxUsd = Math.floor(all.maxAave * 0.995 * 100) / 100;
  const after = statusFor(pos.debtUsd + creditUsd > 0 ? calc.hfAfter : null);

  let block: CreditBlock | undefined;
  if (pos.borrowPaused) block = "paused";
  else if (creditUsd > pos.usdcLiquidity) block = "no-liquidity";
  else if (creditUsd > maxUsd) block = "too-much";
  else if (cashRaw(p.cash) < feeBufferRaw) block = "fee";

  return {
    creditRaw: p.creditRaw,
    backing: chosen.map((c) => ({ stock: c.option.stock, raw: c.raw, usd: c.usd })),
    before: statusFor(pos.healthFactor),
    after,
    hfAfter: calc.hfAfter,
    extraConfirm: creditUsd > 0 && needsExtraConfirm(after),
    maxSafeUsd: Math.floor(all.maxSafe * 100) / 100,
    maxUsd,
    priceMayMove: !marketState(p.now).open,
    block,
  };
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
  backing: Backing[];
  cash: Cash;
  nowSec?: number;
}): Call[] {
  const fromCash = p.quote.amountIn - p.creditRaw;
  if (p.creditRaw <= 0n || fromCash < 0n) throw new Error("Credit must be part of the buy");
  const spend = [...buildLoanCalls({ user: p.user, locks: p.backing, borrowRaw: p.creditRaw }), ...buildBuyCalls(p)];
  return assertCreditBuy(p.user, payFromCash(p.user, fromCash, p.cash, spend), { stock: p.stock, creditRaw: p.creditRaw, cashRaw: fromCash });
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
 * The Credit Buy checks on the finished batch, against what the screen shows: credit is taken once,
 * as USDC to the user, for exactly `creditRaw`; the batch ends with an exact approve and one swap into
 * `stock` (one of the 7), paid to the user, spending exactly the credit plus `cashRaw`.
 */
export function assertCreditBuy(user: Address, calls: Call[], review: { stock: ReserveAsset; creditRaw: bigint; cashRaw: bigint }): Call[] {
  const borrows = calls.flatMap((c, i) => {
    const d = spokeCall(c);
    return d?.functionName === "borrow" ? [{ i, args: d.args }] : [];
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

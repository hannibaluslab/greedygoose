import { decodeFunctionData, erc20Abi, isAddressEqual } from "viem";
import { CREDIT_CAP } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { buildRepayCalls, buildWithdrawCalls, fullRepayAmount, type Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { assertAllowed, swapOf } from "@/lib/allowlist";
import { feeBufferRaw, toUsd } from "@/lib/cash";
import { formatUsdTrim } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { endsInAct, statusFor, type Status } from "@/lib/risk/status";
import { SELL_LIMITS, aaveFloorRaw, buildSellCalls, sellEconomics, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;

/**
 * Where the shares come from (plan item 7): free shares; a backing holding, taken out of backing in the
 * same batch; a backing holding sold to repay credit; or "any", the one rule for Sell, Trade and Send on a stock that
 * backs credit (Adrian, 2026-10-17): the free shares first, then as much backing as the 1.12 line lets out, in the same
 * batch. Its most is "Up to $X"; to do more, the user repays first.
 */
export type SellFrom = "free" | "backing" | "repay" | "any";

/** The holding's fields the plan reads (usePosition's Holding has them all). */
export type SellHolding = {
  priceUsd: number;
  freeRaw: bigint;
  backingRaw: bigint;
  backingUsd: number;
  paused: boolean;
};

/** The position's fields the plan reads (usePosition's data has them all). */
export type SellPosition = {
  totalBackingUsd: number;
  avgCf: number;
  debtUsd: number;
  debtRaw: bigint;
  healthFactor: number | null;
};

export type SellBlock =
  | "paused"
  | "not-free"
  | "not-backing"
  | "nothing-owed"
  | "past-line"
  | "near-limit"
  | "too-small"
  | "act"
  | "price";

export const SELL_BLOCKED: Record<SellBlock, string> = {
  paused: "Aave has paused this stock for now, so it can’t come out of backing. Try again later.",
  "not-free": "That’s more than your free shares.",
  "not-backing": "That’s more than backs your credit.",
  "nothing-owed": "You don’t owe anything, so there’s nothing to repay.",
  "past-line": "That’s more than you can sell right now. Repay some first to sell more.",
  "near-limit":
    "Your credit is too close to Aave’s limit to take these shares out before they repay it. Sell fewer, or repay from cash.",
  "too-small": `The smallest sale is ${formatUsdTrim(SELL_LIMITS.minUsd)}.`,
  act: "That would put your credit in Act. Sell more, or repay from cash.",
  price: `Too big for the market right now: you’d get more than ${SELL_LIMITS.floorBps / 100}% under Aave’s price. Try a smaller amount.`,
};

/**
 * Headroom under Aave's limit for what comes out before the repay, for interest and price moves. A repay by selling
 * usually ends healthier, but not always: it repays the sale's floor less the network-fee buffer, so a small sale can
 * repay less than its shares backed. One that would end in Act, lower than it started, is blocked ("act", Act is the
 * line, Adrian 2026-10-15).
 */
const LIMIT_HEADROOM = 0.995;

export type SellPlan = {
  from: SellFrom;
  /** Shares sold, raw: the quote's amountIn. */
  sharesRaw: bigint;
  /** What the sale pays at the quote, and at least (the swap's floor). */
  usd: number;
  minOutRaw: bigint;
  /** How far under Aave's price the pool pays; `warn` past SELL_LIMITS.warnDiscount. */
  discount: number;
  warn: boolean;
  /**
   * Most shares this sale can take: the free shares; the backing the 1.12 line lets out; the backing that can come out
   * before the repay; for "any", the free shares plus that backing ("Up to $X").
   */
  maxRaw: bigint;
  /** The shares that come out of backing in the same batch (0 when the free shares cover the sale). */
  takeOutRaw: bigint;
  /** Repay by selling: what the sale repays, at least (0 otherwise). */
  repayRaw: bigint;
  before: Status;
  after: Status;
  hfAfter: number | null;
  /** Markets are closed: Aave's price is held while the pools trade, so the screen must say the price may move when they reopen. */
  priceMayMove: boolean;
  /** Why it can't go ahead. */
  block?: SellBlock;
};

/**
 * What a repay by selling repays: the sale's floor less the network-fee buffer (JAW charges the fee in USDC
 * after the batch, so the sale pays it), and no more than a full repay of `debtRaw`. 0 when nothing is left.
 */
export function saleRepayRaw(minOutRaw: bigint, debtRaw: bigint): bigint {
  const spendable = minOutRaw - feeBufferRaw;
  return spendable > 0n ? fullRepayAmount(debtRaw, spendable) : 0n;
}

/** `raw × f`, rounded down; all of it at f ≥ 1. */
const part = (raw: bigint, f: number) =>
  f >= 1 ? raw : f > 0 ? (raw * BigInt(Math.floor(f * 1_000_000))) / 1_000_000n : 0n;

/**
 * Up to $X on a stock that backs credit (the "any" route, Sell, Trade and Send): its free shares plus the backing the
 * 1.12 line lets out, raw. A paused stock, or one whose collateral factor isn't read yet, offers its free shares only.
 */
export function sellableRaw(
  h: Pick<SellHolding, "freeRaw" | "backingRaw" | "backingUsd" | "paused">,
  cf: number | undefined,
  pos: Pick<SellPosition, "totalBackingUsd" | "avgCf" | "debtUsd">,
): bigint {
  if (!cf || h.paused || h.backingRaw === 0n || h.backingUsd <= 0) return h.freeRaw;
  const usd = maxWithdrawUsd({ ...pos, cf, backingUsd: h.backingUsd, targetHf: CREDIT_CAP.minHf });
  return h.freeRaw + part(h.backingRaw, usd / h.backingUsd);
}

/**
 * The most backing shares a repay by selling can take out (planSell's `maxRaw` for "repay"): the shares come out before
 * the repay lands, so the loan must stay within Aave's limit, with LIMIT_HEADROOM, in between. All of them when
 * nothing is owed. Repay's "Pay with" offers a backing stock up to this.
 */
export function repaySaleMaxRaw(
  h: Pick<SellHolding, "backingRaw" | "backingUsd">,
  cf: number,
  pos: Pick<SellPosition, "totalBackingUsd" | "avgCf" | "debtUsd">,
): bigint {
  const creditInput = {
    totalBackingUsd: pos.totalBackingUsd,
    avgCf: pos.avgCf,
    debtUsd: pos.debtUsd,
    cf,
    backingUsd: h.backingUsd,
  };
  return part(h.backingRaw, h.backingUsd > 0 ? (maxWithdrawUsd(creditInput) * LIMIT_HEADROOM) / h.backingUsd : 0);
}

/**
 * Plan a sale of `quote.amountIn` shares on Leo's maths. A backing holding comes out only as far as the 1.12 line
 * allows (maxWithdrawUsd at CREDIT_CAP.minHf, Act is the line), and "any" sells the free shares first. Selling to repay takes the shares out first, so the loan must
 * stay within Aave's limit until the repay lands; it usually ends healthier, and one that would end in Act, lower
 * than it started, is blocked ("act", LIMIT_HEADROOM). Plan only: the batch is simulated before JAW's sheet.
 */
export function planSell(p: {
  from: SellFrom;
  stock: ReserveAsset;
  holding: SellHolding;
  /** The stock's collateral factor (useBackingFactors). */
  cf: number;
  position: SellPosition;
  quote: SellQuote;
  now?: Date;
}): SellPlan {
  const { from, stock, holding: h, position: pos, quote } = p;
  const sharesRaw = quote.amountIn;
  const econ = sellEconomics(quote, stock, h.priceUsd);
  const minOutRaw = sellMinOut(quote, stock, h.priceUsd);
  const valueUsd = (Number(sharesRaw) / 10 ** stock.decimals) * h.priceUsd;
  const creditInput = {
    totalBackingUsd: pos.totalBackingUsd,
    avgCf: pos.avgCf,
    debtUsd: pos.debtUsd,
    cf: p.cf,
    backingUsd: h.backingUsd,
  };
  const backingShare = (usd: number) => part(h.backingRaw, h.backingUsd > 0 ? usd / h.backingUsd : 0);

  const repayRaw = from === "repay" ? saleRepayRaw(minOutRaw, pos.debtRaw) : 0n;
  const lineShare = () => backingShare(maxWithdrawUsd({ ...creditInput, targetHf: CREDIT_CAP.minHf }));
  let maxRaw = h.freeRaw;
  let takeOutRaw = 0n;
  let hfAfter = pos.healthFactor;
  if (from === "backing") {
    maxRaw = lineShare();
    takeOutRaw = sharesRaw;
    hfAfter = healthAfterWithdraw({ ...creditInput, usd: valueUsd });
  } else if (from === "any") {
    maxRaw = sellableRaw(h, p.cf, pos);
    takeOutRaw = sharesRaw > h.freeRaw ? sharesRaw - h.freeRaw : 0n;
    if (takeOutRaw > 0n) {
      hfAfter = healthAfterWithdraw({ ...creditInput, usd: (Number(takeOutRaw) / 10 ** stock.decimals) * h.priceUsd });
    }
  } else if (from === "repay") {
    maxRaw = repaySaleMaxRaw(h, p.cf, pos);
    takeOutRaw = sharesRaw;
    const debtAfter = pos.debtUsd - toUsd(repayRaw);
    hfAfter = debtAfter > 0 ? (pos.totalBackingUsd * pos.avgCf - valueUsd * p.cf) / debtAfter : null;
  }

  let block: SellBlock | undefined;
  if (from !== "free" && takeOutRaw > 0n && h.paused) block = "paused";
  else if (from === "free" && sharesRaw > h.freeRaw) block = "not-free";
  else if (from === "any" && sharesRaw > h.freeRaw + h.backingRaw) block = "not-backing";
  else if (from !== "free" && from !== "any" && sharesRaw > h.backingRaw) block = "not-backing";
  else if (from === "repay" && pos.debtRaw === 0n) block = "nothing-owed";
  else if ((from === "backing" || from === "any") && sharesRaw > maxRaw) block = "past-line";
  else if (from === "repay" && sharesRaw > maxRaw) block = "near-limit";
  else if (econ.usd < SELL_LIMITS.minUsd || (from === "repay" && repayRaw === 0n)) block = "too-small";
  else if (
    from === "repay" &&
    hfAfter !== null &&
    endsInAct(statusFor(hfAfter)) &&
    hfAfter < (pos.healthFactor ?? Infinity)
  )
    block = "act";
  else if (quote.amountOut < aaveFloorRaw(sharesRaw, stock, h.priceUsd)) block = "price";

  return {
    from,
    sharesRaw,
    usd: econ.usd,
    minOutRaw,
    discount: econ.discount,
    warn: econ.discount > SELL_LIMITS.warnDiscount,
    maxRaw,
    takeOutRaw,
    repayRaw,
    before: statusFor(pos.healthFactor),
    after: statusFor(hfAfter),
    hfAfter,
    priceMayMove: !marketState(p.now).open,
    block,
  };
}

/**
 * The sale in one batch: [take the shares out of backing] → approve → swap to USDC [→ approve → repay].
 * The repay spends what the swap is sure to pay (saleRepayRaw of its floor), so it can't fail for a
 * price move within the floor; anything the swap pays over that stays in the wallet as cash. Every call
 * passes the allowlist with the user pinned.
 */
export function buildSaleCalls(p: {
  from: SellFrom;
  user: Address;
  stock: ReserveAsset;
  quote: SellQuote;
  oraclePriceUsd: number;
  debtRaw: bigint;
  nowSec?: number;
  /** "any": the shares that come out of backing first (planSell's takeOutRaw). */
  takeOutRaw?: bigint;
}): Call[] {
  const sell = buildSellCalls(p);
  if (p.from === "free") return sell;
  if (p.from === "any") {
    const out = p.takeOutRaw ?? 0n;
    if (out <= 0n) return sell;
    if (out > p.quote.amountIn) throw new Error("Takes out more than it sells");
    return assertAllowed(p.user, [
      ...buildWithdrawCalls({ user: p.user, stock: p.stock, amountRaw: out, all: false }),
      ...sell,
    ]);
  }
  const sale = [
    ...buildWithdrawCalls({ user: p.user, stock: p.stock, amountRaw: p.quote.amountIn, all: false }),
    ...sell,
  ];
  if (p.from === "backing") return assertAllowed(p.user, sale);
  const repayRaw = saleRepayRaw(sellMinOut(p.quote, p.stock, p.oraclePriceUsd), p.debtRaw);
  return assertAllowed(p.user, [
    ...sale,
    ...buildRepayCalls({ user: p.user, amountRaw: repayRaw, all: repayRaw > p.debtRaw }),
  ]);
}

/**
 * What a repay with free shares repays (Repay's "Pay with" a stock you hold free, Adrian 2026-10-15): exactly what the
 * sale is sure to pay, its swap's floor (`sellMinOut`), and no more than a full repay of `debtRaw`. When the cash can't
 * keep the network-fee buffer, the sale pays the fee and the repay is the floor less the buffer (`saleRepayRaw`). 0 when
 * nothing is left.
 */
export function freeRepayRaw(minOutRaw: bigint, debtRaw: bigint, feeFromSale: boolean): bigint {
  if (feeFromSale) return saleRepayRaw(minOutRaw, debtRaw);
  return minOutRaw > 0n ? fullRepayAmount(debtRaw, minOutRaw) : 0n;
}

const repayOf = (c: Call): bigint | null => {
  if (!isAddressEqual(c.to, AAVE.SPOKE)) return null;
  try {
    const call = decodeFunctionData({ abi: spokeAbi, data: c.data });
    return call.functionName === "repay" ? call.args[1] : null;
  } catch {
    return null;
  }
};

/**
 * A repay that rides on a sale spends only what the sale is sure to bring. Throws unless the batch has exactly one
 * swap into USDC for the user and one repay after it, the repay is no more than the swap's floor (`amountOutMinimum`,
 * less the network-fee buffer when the sale pays the fee), and every USDC approve to the spoke is exactly the repay
 * (or the 0 that resets it). So a batch that would dip into the cash the user already had is never built.
 */
export function assertSaleCoversRepay(user: Address, calls: Call[], feeFromSale: boolean): Call[] {
  const swaps = calls.map((c, i) => ({ i, swap: swapOf(c) })).filter((x) => x.swap !== null);
  const repays = calls
    .map((c, i) => ({ i, raw: repayOf(c) }))
    .filter((x): x is { i: number; raw: bigint } => x.raw !== null);
  if (swaps.length !== 1 || repays.length !== 1)
    throw new Error("Blocked: a repay by selling is one sale and one repay");
  const [{ i: at, swap }] = swaps;
  const [{ i: repayAt, raw: repayRaw }] = repays;
  const sale = swap!.params;
  if (!isAddressEqual(sale.tokenOut, USDC.address) || !isAddressEqual(sale.recipient, user) || repayAt < at) {
    throw new Error("Blocked: the repay must come after a sale into USDC for the user");
  }
  const covered = sale.amountOutMinimum - (feeFromSale ? feeBufferRaw : 0n);
  if (repayRaw <= 0n || repayRaw > covered)
    throw new Error("Blocked: the repay is more than the sale is sure to bring");
  for (const c of calls) {
    if (!isAddressEqual(c.to, USDC.address)) continue;
    const call = decodeFunctionData({ abi: erc20Abi, data: c.data });
    if (
      call.functionName === "approve" &&
      isAddressEqual(call.args[0], AAVE.SPOKE) &&
      call.args[1] !== repayRaw &&
      call.args[1] !== 0n
    ) {
      throw new Error("Blocked: the repay's approval is not exact");
    }
  }
  return calls;
}

/**
 * Repay with a stock you hold free (Repay's "Pay with", Adrian 2026-10-15), in one batch: approve exactly the shares to
 * the router → swap them to USDC for the user, at least `sellMinOut` (the quote less 1%, never under Aave's price less
 * 10%) → approve exactly the repay to the spoke → repay it for the user (→ the allowance back to 0 on a full repay). The
 * repay is `freeRepayRaw` of that floor, computed here and checked again by `assertSaleCoversRepay`, so it can never be
 * more than the sale guarantees; what the sale brings above it stays as cash. No call takes anything out of backing.
 * When the cash pays the network fee, the caller adds what it needs (`payFromCash`).
 */
export function buildFreeRepayCalls(p: {
  user: Address;
  stock: ReserveAsset;
  quote: SellQuote;
  oraclePriceUsd: number;
  debtRaw: bigint;
  /** The cash can't keep the network-fee buffer, so the sale pays the fee. */
  feeFromSale: boolean;
  nowSec?: number;
}): Call[] {
  if (p.debtRaw <= 0n) throw new Error("Nothing owed");
  const repayRaw = freeRepayRaw(sellMinOut(p.quote, p.stock, p.oraclePriceUsd), p.debtRaw, p.feeFromSale);
  const calls = [
    ...buildSellCalls(p),
    ...buildRepayCalls({ user: p.user, amountRaw: repayRaw, all: repayRaw > p.debtRaw }),
  ];
  return assertAllowed(p.user, assertSaleCoversRepay(p.user, calls, p.feeFromSale));
}

/** What Activity shows while a repay with free shares confirms: the sale and the repay. */
export function freeRepayActivity(
  stock: ReserveAsset,
  plan: Pick<SellPlan, "sharesRaw" | "usd">,
  repayRaw: bigint,
): ActivityItem[] {
  return [
    {
      kind: "sell",
      symbol: stock.symbol,
      amount: Number(plan.sharesRaw) / 10 ** stock.decimals,
      receivedUsd: plan.usd,
    },
    { kind: "repay", symbol: USDC.symbol, amount: toUsd(repayRaw) },
  ];
}

/** The lowest price a share sells at in this plan: what the sale pays at least (the swap's floor), per share sold. */
export function floorPriceUsd(
  plan: Pick<SellPlan, "minOutRaw" | "sharesRaw">,
  stock: Pick<ReserveAsset, "decimals">,
): number {
  const shares = Number(plan.sharesRaw) / 10 ** stock.decimals;
  return shares > 0 ? toUsd(plan.minOutRaw) / shares : 0;
}

/** What Activity shows while it confirms: the shares taken out of backing, the sale and the repay. */
export function saleActivity(stock: ReserveAsset, plan: SellPlan): ActivityItem[] {
  const amount = Number(plan.sharesRaw) / 10 ** stock.decimals;
  return [
    ...(plan.takeOutRaw > 0n
      ? [{ kind: "withdraw" as const, symbol: stock.symbol, amount: Number(plan.takeOutRaw) / 10 ** stock.decimals }]
      : []),
    { kind: "sell", symbol: stock.symbol, amount, receivedUsd: plan.usd },
    ...(plan.from === "repay" ? [{ kind: "repay" as const, symbol: USDC.symbol, amount: toUsd(plan.repayRaw) }] : []),
  ];
}

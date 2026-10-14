import { RISK } from "@/config/risk";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { buildRepayCalls, buildWithdrawCalls, fullRepayAmount, type Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, toUsd } from "@/lib/cash";
import { formatUsdTrim } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { statusFor, type Status } from "@/lib/risk/status";
import { SELL_LIMITS, aaveFloorRaw, buildSellCalls, sellEconomics, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;

/**
 * Where the shares come from (plan item 7): free shares; a backing holding, taken out of backing in the
 * same batch; or a backing holding sold to repay credit.
 */
export type SellFrom = "free" | "backing" | "repay";

/** The holding's fields the plan reads (usePosition's Holding has them all). */
export type SellHolding = { priceUsd: number; freeRaw: bigint; lockedRaw: bigint; lockedUsd: number; paused: boolean };

/** The position's fields the plan reads (usePosition's data has them all). */
export type SellPosition = { collateralUsd: number; avgCf: number; debtUsd: number; debtRaw: bigint; healthFactor: number | null };

export type SellBlock = "paused" | "not-free" | "not-backing" | "nothing-owed" | "past-safe" | "near-limit" | "too-small" | "price";

export const SELL_BLOCKED: Record<SellBlock, string> = {
  paused: "Aave has paused this stock for now, so it can’t come out of backing. Try again later.",
  "not-free": "That’s more than your free shares.",
  "not-backing": "That’s more than backs your credit.",
  "nothing-owed": "You don’t owe anything, so there’s nothing to repay.",
  "past-safe": "That would take your credit out of Safe. Sell less, or repay with this sale instead.",
  "near-limit": "Your credit is too close to Aave’s limit to take these shares out before they repay it. Sell fewer, or repay from cash.",
  "too-small": `The smallest sale is ${formatUsdTrim(SELL_LIMITS.minUsd)}.`,
  price: `Too big for the market right now: you’d get more than ${SELL_LIMITS.floorBps / 100}% under Aave’s price. Try a smaller amount.`,
};

/** Headroom under Aave's limit for what comes out before the repay, for interest and price moves (as on the free-up sheet). */
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
  /** Most shares this sale can take: the free shares; the backing that keeps the loan Safe; the backing that can come out before the repay. */
  maxRaw: bigint;
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
const part = (raw: bigint, f: number) => (f >= 1 ? raw : f > 0 ? (raw * BigInt(Math.floor(f * 1_000_000))) / 1_000_000n : 0n);

/**
 * Plan a sale of `quote.amountIn` shares on Leo's maths. A backing holding comes out only as far as the loan
 * stays Safe (maxWithdrawUsd at the Safe line). Selling to repay takes the shares out first, so the loan must
 * stay within Aave's limit until the repay lands; it always ends healthier. Plan only: the batch is simulated
 * before JAW's sheet.
 */
export function planSell(p: {
  from: SellFrom;
  stock: ReserveAsset;
  holding: SellHolding;
  /** The stock's collateral factor (useCollateralFactors). */
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
  const loan = { collateralUsd: pos.collateralUsd, avgCf: pos.avgCf, debtUsd: pos.debtUsd, cf: p.cf, lockedUsd: h.lockedUsd };
  const backingShare = (usd: number) => part(h.lockedRaw, h.lockedUsd > 0 ? usd / h.lockedUsd : 0);

  const repayRaw = from === "repay" ? saleRepayRaw(minOutRaw, pos.debtRaw) : 0n;
  let maxRaw = h.freeRaw;
  let hfAfter = pos.healthFactor;
  if (from === "backing") {
    maxRaw = backingShare(maxWithdrawUsd({ ...loan, targetHf: RISK.safeMin }));
    hfAfter = healthAfterWithdraw({ ...loan, usd: valueUsd });
  } else if (from === "repay") {
    maxRaw = backingShare(maxWithdrawUsd(loan) * LIMIT_HEADROOM);
    const debtAfter = pos.debtUsd - toUsd(repayRaw);
    hfAfter = debtAfter > 0 ? (pos.collateralUsd * pos.avgCf - valueUsd * p.cf) / debtAfter : null;
  }

  let block: SellBlock | undefined;
  if (from !== "free" && h.paused) block = "paused";
  else if (from === "free" && sharesRaw > h.freeRaw) block = "not-free";
  else if (from !== "free" && sharesRaw > h.lockedRaw) block = "not-backing";
  else if (from === "repay" && pos.debtRaw === 0n) block = "nothing-owed";
  else if (from === "backing" && sharesRaw > maxRaw) block = "past-safe";
  else if (from === "repay" && sharesRaw > maxRaw) block = "near-limit";
  else if (econ.usd < SELL_LIMITS.minUsd || (from === "repay" && repayRaw === 0n)) block = "too-small";
  else if (quote.amountOut < aaveFloorRaw(sharesRaw, stock, h.priceUsd)) block = "price";

  return {
    from,
    sharesRaw,
    usd: econ.usd,
    minOutRaw,
    discount: econ.discount,
    warn: econ.discount > SELL_LIMITS.warnDiscount,
    maxRaw,
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
}): Call[] {
  const sell = buildSellCalls(p);
  if (p.from === "free") return sell;
  const sale = [...buildWithdrawCalls({ user: p.user, stock: p.stock, amountRaw: p.quote.amountIn, all: false }), ...sell];
  if (p.from === "backing") return assertAllowed(p.user, sale);
  const repayRaw = saleRepayRaw(sellMinOut(p.quote, p.stock, p.oraclePriceUsd), p.debtRaw);
  return assertAllowed(p.user, [...sale, ...buildRepayCalls({ user: p.user, amountRaw: repayRaw, all: repayRaw > p.debtRaw })]);
}

/** The lowest price a share sells at in this plan: what the sale pays at least (the swap's floor), per share sold. */
export function floorPriceUsd(plan: Pick<SellPlan, "minOutRaw" | "sharesRaw">, stock: Pick<ReserveAsset, "decimals">): number {
  const shares = Number(plan.sharesRaw) / 10 ** stock.decimals;
  return shares > 0 ? toUsd(plan.minOutRaw) / shares : 0;
}

/** What Activity shows while it confirms: the shares taken out of backing, the sale and the repay. */
export function saleActivity(stock: ReserveAsset, plan: SellPlan): ActivityItem[] {
  const amount = Number(plan.sharesRaw) / 10 ** stock.decimals;
  return [
    ...(plan.from === "free" ? [] : [{ kind: "withdraw" as const, symbol: stock.symbol, amount }]),
    { kind: "sell", symbol: stock.symbol, amount, receivedUsd: plan.usd },
    ...(plan.from === "repay" ? [{ kind: "repay" as const, symbol: USDC.symbol, amount: toUsd(plan.repayRaw) }] : []),
  ];
}

import { ACT_LINE, type CreditLine, stopsAtAct } from "@/config/risk";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { buildRepayCalls, buildWithdrawCalls, fullRepayAmount, type Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, toUsd } from "@/lib/cash";
import { buildAddSavingsCalls } from "@/lib/savings";
import { formatUsdTrim } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { freeUpFloor } from "@/lib/freeUpPlan";
import { statusFor, type Status } from "@/lib/risk/status";
import type { HealthFloor } from "@/lib/tx/prepared";
import { SELL_LIMITS, aaveFloorRaw, buildSellCalls, sellEconomics, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";
import { assertSaleCoversRepay, assertSaleCoversSave } from "./sell/covers";

type Address = `0x${string}`;

/**
 * Where the shares come from (plan item 7): free shares; a backing holding, taken out of backing in the
 * same batch; or a backing holding sold to repay credit. Sell, Trade and Send sell free shares only: shares that back
 * credit come back with a repay first.
 */
export type SellFrom = "free" | "backing" | "repay";

/**
 * No dust (ruling 7b): a sale or send that would leave less than this of the stock takes all of it instead.
 */
export const NO_DUST_USD = 1;

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
  /** How low freeing shares may take the health (lib/creditBuy.ts lineOf): ACT_LINE without. */
  line?: CreditLine;
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
  | "under-line"
  | "price";

export const SELL_BLOCKED: Record<SellBlock, string> = {
  paused: "Aave has paused this stock for now, so it can’t come out of backing. Try again later.",
  "not-free": "That’s more than your free shares.",
  "not-backing": "That’s more than backs your credit.",
  "nothing-owed": "You don’t owe anything, so there’s nothing to repay.",
  "past-line": "That’s more than you can sell right now. Repay some first to sell more.",
  "near-limit":
    "Your credit is too close to Aave’s limit to free these shares before the repay lands. Sell fewer, or repay from cash.",
  "too-small": `Minimum sale is ${formatUsdTrim(SELL_LIMITS.minUsd)}.`,
  act: "That would put your credit in Act. Sell more, or repay from cash.",
  "under-line": "That would take your credit past its limit. Sell more, or repay from cash.",
  price: `Too big for the market right now. You’d get more than ${SELL_LIMITS.floorBps / 100}% under Aave’s price. Try a smaller amount.`,
};

/**
 * A margin under Aave's limit for what comes out before the repay, for interest and price moves. A repay by selling
 * usually ends healthier, but not always: it repays the sale's floor less the network-fee buffer, so a small sale can
 * repay less than its shares backed. One that would end in Act, lower than it started, is blocked ("act", Act is the
 * line, Adrian 2026-10-15).
 */
const LIMIT_MARGIN = 0.995;

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
  /** Most shares this sale can take: the free shares; the backing the line's cap lets out (1.12 under ACT_LINE); the backing that can come out before the repay. */
  maxRaw: bigint;
  /** The shares that come out of backing in the same batch (0 when the free shares cover the sale). */
  takeOutRaw: bigint;
  /** Repay by selling: what the sale repays, at least (0 otherwise). */
  repayRaw: bigint;
  /** Shares from backing that end in Act, which the line allows once Greedy Fatalities is open: the Wall's tick. */
  intoAct: boolean;
  /** What a batch that takes shares out of backing is held to on Aave's health (freeUpFloor of the line). */
  floor: HealthFloor;
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
 * The most backing shares a repay by selling can take out (planSell's `maxRaw` for "repay"): the shares come out before
 * the repay lands, so the credit must stay within Aave's limit, with LIMIT_MARGIN, in between. All of them when
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
  return part(h.backingRaw, h.backingUsd > 0 ? (maxWithdrawUsd(creditInput) * LIMIT_MARGIN) / h.backingUsd : 0);
}

/** Why a sale can't go ahead, first match, in this order (planSell). */
function sellBlock(
  p: Parameters<typeof planSell>[0],
  s: { takeOutRaw: bigint; maxRaw: bigint; repayRaw: bigint; hfAfter: number | null; usd: number },
): SellBlock | undefined {
  const { from, holding: h, position: pos, quote, stock } = p;
  const { maxRaw, repayRaw, hfAfter } = s;
  const sharesRaw = quote.amountIn;
  if (from !== "free" && s.takeOutRaw > 0n && h.paused) return "paused";
  if (from === "free" && sharesRaw > h.freeRaw) return "not-free";
  if (from !== "free" && sharesRaw > h.backingRaw) return "not-backing";
  if (from === "repay" && pos.debtRaw === 0n) return "nothing-owed";
  if (from === "backing" && sharesRaw > maxRaw) return "past-line";
  if (from === "repay" && sharesRaw > maxRaw) return "near-limit";
  if (s.usd < SELL_LIMITS.minUsd || (from === "repay" && repayRaw === 0n)) return "too-small";
  const line = pos.line ?? ACT_LINE;
  if (from === "repay" && hfAfter !== null && hfAfter < line.stopHf && hfAfter < (pos.healthFactor ?? Infinity))
    return stopsAtAct(line) ? "act" : "under-line";
  if (quote.amountOut < aaveFloorRaw(sharesRaw, stock, h.priceUsd)) return "price";
  return undefined;
}

/**
 * Plan a sale of `quote.amountIn` shares on Leo's maths. A backing holding comes out only as far as the line's cap
 * allows (maxWithdrawUsd at 1.12 under ACT_LINE, Act is the line; nearer Aave's once Greedy Fatalities is open). Selling to repay takes the shares out first, so the credit must
 * stay within Aave's limit until the repay lands; it usually ends healthier, and one that would end in Act, lower
 * than it started, is blocked ("act", LIMIT_MARGIN). Plan only: the batch is simulated before JAW's sheet.
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
  const line = pos.line ?? ACT_LINE;
  const lineShare = () => backingShare(maxWithdrawUsd({ ...creditInput, targetHf: line.capHf }));
  let maxRaw = h.freeRaw;
  let takeOutRaw = 0n;
  let hfAfter = pos.healthFactor;
  if (from === "backing") {
    maxRaw = lineShare();
    takeOutRaw = sharesRaw;
    hfAfter = healthAfterWithdraw({ ...creditInput, usd: valueUsd });
  } else if (from === "repay") {
    maxRaw = repaySaleMaxRaw(h, p.cf, pos);
    takeOutRaw = sharesRaw;
    const debtAfter = pos.debtUsd - toUsd(repayRaw);
    hfAfter = debtAfter > 0 ? (pos.totalBackingUsd * pos.avgCf - valueUsd * p.cf) / debtAfter : null;
  }

  const block = sellBlock(p, { takeOutRaw, maxRaw, repayRaw, hfAfter, usd: econ.usd });

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
    intoAct: line.intoAct && from === "backing" && statusFor(hfAfter) === "act",
    floor: freeUpFloor(line),
    priceMayMove: !marketState(p.now).open,
    block,
  };
}

/**
 * What a sale into cash puts straight into savings (Adrian, 2026-10-18: "place the usdc directly into savings"): the
 * swap's floor, less what the wallet needs to reach the network-fee buffer (JAW charges the fee in USDC after the batch).
 * Anything the swap pays over its floor stays in the wallet. 0 when nothing is left to put in.
 */
export function saleSaveRaw(minOutRaw: bigint, walletRaw: bigint): bigint {
  const keep = feeBufferRaw > walletRaw ? feeBufferRaw - walletRaw : 0n;
  return minOutRaw > keep ? minOutRaw - keep : 0n;
}

/**
 * The sale in one batch: [take the shares out of backing] → approve → swap to USDC, then either → approve → supply the
 * floor into savings (a sale into cash, given the wallet's USDC: saleSaveRaw), or → approve → repay (a repay by
 * selling). Both spend only what the swap is sure to pay, so they can't fail for a price move within the floor;
 * anything the swap pays over that stays in the wallet as cash. Every call passes the allowlist with the user pinned.
 */
export function buildSaleCalls(p: {
  from: SellFrom;
  user: Address;
  stock: ReserveAsset;
  quote: SellQuote;
  oraclePriceUsd: number;
  debtRaw: bigint;
  /** The wallet's USDC before the sale: a sale into cash puts what it brings into savings (saleSaveRaw). */
  walletRaw?: bigint;
  nowSec?: number;
}): Call[] {
  const sell = buildSellCalls(p);
  const sale =
    p.from === "free"
      ? sell
      : [...buildWithdrawCalls({ user: p.user, stock: p.stock, amountRaw: p.quote.amountIn, all: false }), ...sell];
  if (p.from !== "repay") {
    const saveRaw =
      p.walletRaw === undefined ? 0n : saleSaveRaw(sellMinOut(p.quote, p.stock, p.oraclePriceUsd), p.walletRaw);
    if (saveRaw === 0n) return p.from === "free" ? sale : assertAllowed(p.user, sale);
    const calls = [...sale, ...buildAddSavingsCalls(p.user, saveRaw)];
    return assertAllowed(p.user, assertSaleCoversSave(p.user, calls, p.walletRaw ?? 0n), { saveTo: p.user });
  }
  const repayRaw = saleRepayRaw(sellMinOut(p.quote, p.stock, p.oraclePriceUsd), p.debtRaw);
  return assertAllowed(p.user, [...sale, ...buildRepayCalls({ user: p.user, amountRaw: repayRaw })]);
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

/**
 * Repay with a stock you hold free (Repay's "Pay with", Adrian 2026-10-15), in one batch: approve exactly the shares to
 * the router → swap them to USDC for the user, at least `sellMinOut` (the quote less 1%, never under Aave's price less
 * 10%) → approve exactly the repay to the spoke → repay it for the user → the allowance back to 0 (buildRepayCalls). The
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
  const calls = [...buildSellCalls(p), ...buildRepayCalls({ user: p.user, amountRaw: repayRaw })];
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

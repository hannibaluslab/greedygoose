import { CASH } from "@/config/risk";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
import type { ActivityItem } from "@/lib/activity/decode";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, feeFromSale, toUsd, type Cash } from "@/lib/cash";
import type { SellPlan } from "@/lib/sell";
import { BUY_LIMITS, SLIP_KEEP, buildBuyCalls, type BuyQuote, type Call } from "@/lib/swap/buy";
import { SELL_LIMITS, buildSellCalls, sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;

/** Raw shares that `usdRaw` (USDC, 6 decimals) buys at Aave's `priceRaw` (8 decimals), rounded down; 0 at no price. */
export function sharesForUsdRaw(usdRaw: bigint, priceRaw: bigint, decimals: number): bigint {
  if (priceRaw <= 0n || usdRaw <= 0n) return 0n;
  return (usdRaw * 10n ** BigInt(decimals + ORACLE_DECIMALS - USDC.decimals)) / priceRaw;
}

/**
 * What the buy in a stock → stock trade spends: exactly the sale's floor, which the router guarantees reaches the
 * user first, so the trade never spends cash the user already had. When the cash can't pay the network fee, the
 * buffer stays out of the buy and the sale pays the fee (as `saleRepayRaw` does). Never negative.
 */
export function swapBuyInRaw(sellFloorRaw: bigint, cash: Cash): bigint {
  const buyIn = feeFromSale(cash) ? sellFloorRaw - feeBufferRaw : sellFloorRaw;
  return buyIn > 0n ? buyIn : 0n;
}

/**
 * The smallest stock → stock trade, in dollars at Aave's price: its buy must reach BUY_LIMITS.minUsd from the sale's
 * floor (the quote less 1%), plus the fee buffer when the sale pays the fee. `rate` is what the pool pays per dollar at
 * Aave's price (1 before a quote). Rounded up to the cent, and never under the smallest sale.
 */
export function swapMinUsd(rate: number, fromSale: boolean): number {
  const need = BUY_LIMITS.minUsd + (fromSale ? CASH.feeBufferUsd : 0);
  const r = rate > 0 ? rate : 1;
  const usd = need / (r * SLIP_KEEP);
  return Math.max(SELL_LIMITS.minUsd, Math.ceil(usd * 100 - 1e-9) / 100);
}

/**
 * Stock → stock in one batch: approve A → swap A for USDC to the user, at least `sellMinOut` → approve exactly the
 * buy's USDC → swap it for B to the user, at least the quote less 1%. The buy can't spend more than the sale is sure to
 * bring, so the router stops the batch before it would touch the user's own cash. Free shares only: no call reaches
 * the Aave spoke, so credit and backing can't move. Every call passes the allowlist with the user pinned.
 */
export function buildTradeCalls(p: {
  user: Address;
  from: ReserveAsset;
  to: ReserveAsset;
  sellQuote: SellQuote;
  buyQuote: BuyQuote;
  /** Aave's price for `from`, for the sale's floor. */
  oraclePriceUsd: number;
  nowSec?: number;
}): Call[] {
  if (p.from.kind !== "equity" || p.to.kind !== "equity" || p.from.address === p.to.address)
    throw new Error("Not a supported trade");
  const floor = sellMinOut(p.sellQuote, p.from, p.oraclePriceUsd);
  if (p.buyQuote.amountIn > floor) throw new Error("Blocked: the buy spends more than the sale is sure to bring");
  const nowSec = p.nowSec ?? Math.floor(Date.now() / 1000);
  return assertAllowed(p.user, [
    ...buildSellCalls({ user: p.user, stock: p.from, quote: p.sellQuote, oraclePriceUsd: p.oraclePriceUsd, nowSec }),
    ...buildBuyCalls({ user: p.user, stock: p.to, quote: p.buyQuote, nowSec }),
  ]);
}

/** What Activity shows while a stock → stock trade confirms, in the order the receipt reads (the buy, then the sale). */
export function tradeActivity(p: {
  from: ReserveAsset;
  to: ReserveAsset;
  plan: SellPlan;
  buyQuote: BuyQuote;
}): ActivityItem[] {
  return [
    {
      kind: "buy",
      symbol: p.to.symbol,
      amount: Number(p.buyQuote.amountOut) / 10 ** p.to.decimals,
      paidUsd: toUsd(p.buyQuote.amountIn),
    },
    {
      kind: "sell",
      symbol: p.from.symbol,
      amount: Number(p.plan.sharesRaw) / 10 ** p.from.decimals,
      receivedUsd: p.plan.usd,
    },
  ];
}

import { type Call } from "@/lib/aave/tx";
import { payFromCash } from "@/lib/cash";
import { TRADE_COPY, buildTradeCalls, saleBlockText, swapMinUsd, tradeActivity } from "@/lib/trade";
import { type SellPlan } from "@/lib/sell";
import { QUOTE_MOVED, quoteKey, type BuyQuote, type Side } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { type ReserveAsset } from "@/lib/tokens/registry";
import { TxStop, txKey, type TxPlan } from "../prepared";
import type { Address, CashToSign } from "./types";

/** What the Trade sheet signs, per route, with the quotes and the plan its screen shows. */
export type TradeSign =
  | { route: "buy"; user: Address; stock: ReserveAsset; quote: BuyQuote }
  | {
      route: "sell";
      user: Address;
      stock: ReserveAsset;
      quote: SellQuote;
      plan: SellPlan;
      oraclePriceUsd: number;
      debtRaw: bigint;
    }
  | {
      route: "swap";
      user: Address;
      from: ReserveAsset;
      to: ReserveAsset;
      sellQuote: SellQuote;
      /** planSell (free shares) for `sellQuote`. */
      plan: SellPlan;
      /** The buy's quote for the screen's buy-in (the sale's floor, less the fee buffer when the sale pays the fee). */
      buyQuote: BuyQuote;
      /** Aave's price for `from`, for the sale's floor. */
      oraclePriceUsd: number;
      /** The cash can't keep the fee buffer, so the sale pays the network fee (swapBuyInRaw). */
      feeFromSale: boolean;
    };

/** What the stock → stock batch reads again while it's prepared (useSigningQuote, useSigningCash). */
export type SwapReads = {
  quoteToSign: (stock: ReserveAsset, shown: BuyQuote, side?: Side) => Promise<BuyQuote>;
  cashToSign: CashToSign;
};

/**
 * stock → stock's batch, built from fresh reads before JAW's sheet. A sale the screen blocked stops here too. Both quotes are read
 * again on their pools (never under the screen's floors, else QUOTE_MOVED from the read itself), and the buy must still
 * spend no more than the fresh sale's floor (else QUOTE_MOVED). When the sale pays the network fee, the batch is the
 * sale and the buy alone; otherwise the cash is read again and pays it (payFromCash: a savings withdrawal goes first
 * when the wallet can't be counted on for the fee).
 */
export async function swapBatch(p: Extract<TradeSign, { route: "swap" }>, reads: SwapReads): Promise<Call[]> {
  if (p.plan.block) throw new TxStop(saleBlockText(p.plan.block, true, swapMinUsd(1 - p.plan.discount, p.feeFromSale)));
  const [sellQuote, buyQuote] = await Promise.all([
    reads.quoteToSign(p.from, p.sellQuote, "sell"),
    reads.quoteToSign(p.to, p.buyQuote, "buy"),
  ]);
  if (buyQuote.amountIn > sellMinOut(sellQuote, p.from, p.oraclePriceUsd)) throw new TxStop(QUOTE_MOVED);
  const calls = buildTradeCalls({
    user: p.user,
    from: p.from,
    to: p.to,
    sellQuote,
    buyQuote,
    oraclePriceUsd: p.oraclePriceUsd,
  });
  return p.feeFromSale ? calls : payFromCash(p.user, 0n, await reads.cashToSign(p.user, 0n), calls);
}

/** What stock → stock signs (useTx), keyed by both legs, both quotes, the sale's floor and stop, and who pays the fee. */
export const swapPlan = (p: Extract<TradeSign, { route: "swap" }>, reads: SwapReads): TxPlan => ({
  key: txKey(
    "swap",
    p.user,
    p.from.symbol,
    p.to.symbol,
    quoteKey(p.sellQuote),
    sellMinOut(p.sellQuote, p.from, p.oraclePriceUsd),
    quoteKey(p.buyQuote),
    p.plan.block ?? null,
    p.feeFromSale,
  ),
  user: p.user,
  calls: () => swapBatch(p, reads),
  fallback: TRADE_COPY.swapFallback,
  activity: tradeActivity({ from: p.from, to: p.to, plan: p.plan, buyQuote: p.buyQuote }),
});

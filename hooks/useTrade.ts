"use client";

import { TxStop, useTx } from "./useTx";
import { BUY_FALLBACK, buyActivity, useCashBuyBatch } from "./useBuy";
import { useSigningQuote } from "./useBuyQuote";
import { SELL_FALLBACK, useSaleBatch } from "./useSell";
import { useSigningCash } from "./useSigningCash";
import { payFromCash } from "@/lib/cash";
import { saleActivity, type SellPlan } from "@/lib/sell";
import { QUOTE_MOVED, type BuyQuote } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { TRADE_COPY, buildTradeCalls, saleBlockText, swapMinUsd, tradeActivity } from "@/lib/trade";
import type { ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;

/** What the Trade sheet signs, per route, with the quotes and the plan its screen shows. */
export type TradeSign =
  | { route: "buy"; user: Address; stock: ReserveAsset; quote: BuyQuote }
  | { route: "sell"; user: Address; stock: ReserveAsset; quote: SellQuote; plan: SellPlan; oraclePriceUsd: number; debtRaw: bigint }
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

/**
 * The Trade sheet's one write path: one useTx, one batch per route, built right before JAW's sheet. cash → stock is the
 * Buy step's batch (useCashBuyBatch) and stock → cash the free-shares sale (useSaleBatch), unchanged. stock → stock
 * reads both quotes again on their pools (never under the screen's floors), checks the buy still spends no more than
 * the sale's floor, then builds the sale and the buy in one batch (buildTradeCalls). When the cash pays the fee, the
 * cash is read again too, and a savings withdrawal goes first if the wallet can't be counted on for the fee.
 */
export function useTrade() {
  const tx = useTx(TRADE_COPY.failedOnChain);
  const cashBuy = useCashBuyBatch();
  const sale = useSaleBatch();
  const quoteToSign = useSigningQuote();
  const cashToSign = useSigningCash();

  const trade = (p: TradeSign) => {
    if (p.route === "buy") return tx.run(p.user, () => cashBuy(p), BUY_FALLBACK, buyActivity(p.stock, p.quote));
    if (p.route === "sell") return tx.run(p.user, () => sale(p), SELL_FALLBACK.free, saleActivity(p.stock, p.plan));
    return tx.run(
      p.user,
      async () => {
        if (p.plan.block) throw new TxStop(saleBlockText(p.plan.block, true, swapMinUsd(1 - p.plan.discount, p.feeFromSale)));
        const [sellQuote, buyQuote] = await Promise.all([quoteToSign(p.from, p.sellQuote, "sell"), quoteToSign(p.to, p.buyQuote, "buy")]);
        if (buyQuote.amountIn > sellMinOut(sellQuote, p.from, p.oraclePriceUsd)) throw new TxStop(QUOTE_MOVED);
        const calls = buildTradeCalls({ user: p.user, from: p.from, to: p.to, sellQuote, buyQuote, oraclePriceUsd: p.oraclePriceUsd });
        return p.feeFromSale ? calls : payFromCash(p.user, 0n, await cashToSign(p.user, 0n), calls);
      },
      TRADE_COPY.swapFallback,
      tradeActivity({ from: p.from, to: p.to, plan: p.plan, buyQuote: p.buyQuote }),
    );
  };
  return { ...tx, trade };
}

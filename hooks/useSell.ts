"use client";

import { FREE_UP_FLOOR } from "@/lib/freeUpPlan";
import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { TxStop, txKey, useTx, type TxPlan } from "./useTx";
import { useDebounced, useSigningQuote } from "./useBuyQuote";
import { CHAIN_ID } from "@/lib/chain";
import { readCash } from "@/lib/cash/read";
import { SELL_BLOCKED, buildSaleCalls, saleActivity, saleRepayRaw, type SellFrom, type SellPlan } from "@/lib/sell";
import { quoteKey, quoteSwap } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import type { ReserveAsset } from "@/lib/tokens/registry";

/** Best quote for selling `sharesRaw` of `stock` for USDC, across Leo's venues. `null` = no pool can fill it. */
export function useSellQuote(stock: ReserveAsset | undefined, sharesRaw: bigint) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const shares = useDebounced(sharesRaw);
  return useQuery({
    queryKey: ["sellQuote", stock?.address, shares.toString()],
    enabled: !!client && !!stock && shares > 0n,
    refetchInterval: 15_000,
    queryFn: (): Promise<SellQuote | null> => quoteSwap(client!, stock!, shares, "sell"),
  });
}

export type SellInput = {
  user: `0x${string}`;
  stock: ReserveAsset;
  /** The quote the screen shows. */
  quote: SellQuote;
  /** planSell for that quote. */
  plan: SellPlan;
  /** Aave's price for the stock, for the swap's floor (the holding's priceUsd). */
  oraclePriceUsd: number;
  /** What the account owes, for a repay by selling (the position's debtRaw). */
  debtRaw: bigint;
};

const SELL_FALLBACK: Record<SellFrom, string> = {
  free: "This sale would fail right now. The price may have moved or the stock may be paused. Try again in a moment.",
  backing:
    "This sale would fail right now. The price or Aave’s limits may have moved. Try a smaller amount in a moment.",
  // On the Repay sheet (Pay with a stock that backs the credit): no protocol words on screen.
  repay: "This repay would fail right now. The price or your credit may have moved. Try a smaller amount in a moment.",
};

/**
 * A sale's batch, built from fresh reads before JAW's sheet: the screen's block still holds, and the quote is read
 * again, and the wallet's USDC for what goes into savings. The stock sheet's Sell and the Trade sheet's stock → cash.
 */
export function useSaleBatch() {
  const quoteToSign = useSigningQuote();
  const client = usePublicClient({ chainId: CHAIN_ID });
  return async (p: SellInput) => {
    if (p.plan.block) throw new TxStop(SELL_BLOCKED[p.plan.block]);
    const quote = await quoteToSign(p.stock, p.quote, "sell");
    // A sale into cash goes straight into savings: the wallet's USDC, read again, says what stays for the fee.
    const walletRaw = p.plan.from === "repay" ? undefined : (await readCash(client!, p.user)).walletRaw;
    return buildSaleCalls({ ...p, from: p.plan.from, quote, walletRaw });
  };
}

/**
 * What a sale signs (useTx), keyed by what shapes its batch: the account, the stock, the quote, the floor (the quote's
 * and Aave's price's), where the shares come from and its stop, and for a repay by selling whether the floor covers
 * what's owed. Not what's owed itself: it accrues every block, and the repay then is the debt plus Aave's interest
 * buffer (covered) or the floor less the fee (not), so its batch only changes when that does.
 */
export const salePlan = (p: SellInput, batch: ReturnType<typeof useSaleBatch>): TxPlan => {
  const floor = sellMinOut(p.quote, p.stock, p.oraclePriceUsd);
  return {
    key: txKey(
      "sell",
      p.user,
      p.stock.symbol,
      quoteKey(p.quote),
      floor,
      p.plan.from,
      p.plan.takeOutRaw,
      p.plan.block ?? null,
      p.plan.from === "repay" ? (saleRepayRaw(floor, p.debtRaw) > p.debtRaw ? "full" : "part") : null,
    ),
    user: p.user,
    calls: () => batch(p),
    fallback: SELL_FALLBACK[p.plan.from],
    // Shares taken out of backing for the sale: held to the Act line on Aave's own health, as Free up is.
    ...(p.plan.takeOutRaw > 0n && p.plan.from !== "repay" ? { healthFloor: FREE_UP_FLOOR } : {}),
    activity: saleActivity(p.stock, p.plan),
  };
};

/**
 * Sell stock in one batch (plan item 7 steps 2, 3 and 9): free shares, a backing holding, or a backing holding sold to
 * repay. `input` is what the Sell step would sign now (null while it can't): its batch is prepared while the step is
 * idle, with the screen's block checked and the quote read again, so `sign()` opens JAW's sheet straight from the tap.
 */
export function useSell(input: SellInput | null) {
  const batch = useSaleBatch();
  return useTx(
    "The sale didn’t go through on Base. Nothing moved except any network fee.",
    input ? salePlan(input, batch) : null,
  );
}

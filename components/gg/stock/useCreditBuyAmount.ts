"use client";

import { useAccount } from "wagmi";
import { wholeUsd } from "./CreditBuyBacking";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useCreditBuy } from "@/hooks/useCreditBuy";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { CREDIT_BLOCKED, type BackingOption, type CreditPlan } from "@/lib/creditBuy";
import { formatUsd } from "@/lib/formatting";
import { BUY_LIMITS, quoteEconomics } from "@/lib/swap/buy";
import type { ReserveAsset } from "@/lib/tokens/registry";

/** Why the amount can't be bought yet, first reason only; none when it can. */
function amountBlocker({
  pickGone,
  amount,
  reachUsd,
  chosen,
  plan,
  stock,
  quote,
  econ,
}: {
  pickGone: boolean;
  amount: number;
  reachUsd: number;
  chosen: BackingOption | null;
  plan: CreditPlan;
  stock: ReserveAsset | null;
  quote: ReturnType<typeof useBuyQuote>;
  econ: ReturnType<typeof quoteEconomics> | null;
}): string | null {
  if (pickGone) return "That stock can’t back credit right now.";
  if (amount > 0 && amount < BUY_LIMITS.minUsd) return `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`;
  if (amount > reachUsd + 1e-9)
    return chosen
      ? `${chosen.stock.name} can back up to ${wholeUsd(reachUsd)}. Pick another stock for more.`
      : `Credit ready goes up to ${wholeUsd(reachUsd)}. Back new credit with a stock for more.`;
  if (amount > 0 && plan.block) return CREDIT_BLOCKED[plan.block];
  if (stock && amount > 0 && quote.isSuccess && (quote.data ?? null) === null)
    return `There’s no market for ${stock.name} right now.`;
  if (econ && econ.premium > BUY_LIMITS.blockPremium)
    return `Too big for the market right now: you’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. Try a smaller amount.`;
  return null;
}

/**
 * Step 3's buy: the quote for the amount, why it can't go yet, and the Credit Buy batch, prepared while the step is
 * idle so the tap opens JAW's sheet at once.
 */
export function useCreditBuyAmount({
  open,
  onAmountStep,
  user,
  stock,
  amount,
  creditRaw,
  plan,
  ack,
  pickGone,
  reachUsd,
  chosen,
  priceOf,
}: {
  open: boolean;
  onAmountStep: boolean;
  user: `0x${string}`;
  stock: ReserveAsset | null;
  amount: number;
  creditRaw: bigint;
  plan: CreditPlan;
  ack: boolean;
  pickGone: boolean;
  reachUsd: number;
  chosen: BackingOption | null;
  priceOf: (symbol: string) => number;
}) {
  const { isConnected } = useAccount();
  const fee = useFeeSupport();
  const quote = useBuyQuote(stock ?? undefined, amount);
  const q = quote.data ?? null;
  const oraclePriceUsd = stock ? priceOf(stock.symbol) : 0;
  const econ = q && stock ? quoteEconomics(q, stock, oraclePriceUsd) : null;

  const blocker = amountBlocker({ pickGone, amount, reachUsd, chosen, plan, stock, quote, econ });
  const ready = amount >= BUY_LIMITS.minUsd && !!econ && q?.amountIn === creditRaw && !blocker && !quote.isFetching;
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Credit Buy would sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
  const signable =
    open && onAmountStep && stock && q && ready && !feeBlocked && !(plan.extraConfirm && !ack)
      ? { user, stock, quote: q, plan, confirmedRisk: ack }
      : null;
  const tx = useCreditBuy(signable);
  return {
    quote,
    q,
    econ,
    oraclePriceUsd,
    blocker,
    ready,
    feeBlocked,
    feeLoading: fee.loading,
    isConnected,
    signable: !!signable,
    tx,
  };
}

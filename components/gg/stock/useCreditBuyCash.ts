"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { overReach } from "./useCreditBuyAmount";
import { useEarnRates } from "@/hooks/useEarnWithStocks";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { PositionData } from "@/hooks/usePosition";
import { useSigningCash } from "@/hooks/useSigningCash";
import { useTx } from "@/hooks/useTx";
import { aprToApy } from "@/lib/aave/math";
import { CREDIT_BLOCKED, type BackingOption, type CreditPlan } from "@/lib/creditBuy";
import { toCashQuote } from "@/lib/creditBuy/toCash";
import { earnDone } from "@/lib/earnWithStocks";
import { toCashPlan } from "@/lib/tx/plans";

const TO_CASH_FAILED = "The Credit Buy didn’t go through on Base. Nothing moved except any network fee.";

/**
 * The Cash row's amount (Credit Buy into savings): what the credit costs once it lands, read from a simulation of its
 * batch (useEarnRates), against what the cash earns; why it can't go yet; and its batch, prepared while the step is idle
 * so the tap opens JAW's sheet at once. Once it lands: Home, with "$X is in your cash, earning."
 */
export function useCreditBuyCash({
  open,
  onCashStep,
  user,
  data,
  plan,
  amount,
  ack,
  pickGone,
  reachUsd,
  chosen,
  onClose,
}: {
  open: boolean;
  onCashStep: boolean;
  user: `0x${string}`;
  data: PositionData;
  plan: CreditPlan;
  amount: number;
  ack: boolean;
  pickGone: boolean;
  reachUsd: number;
  chosen: BackingOption | null;
  onClose: () => void;
}) {
  const { isConnected } = useAccount();
  const fee = useFeeSupport();
  const cashToSign = useSigningCash();
  const apyNow = aprToApy(data.apr);
  const rates = useEarnRates({
    user,
    backing: plan.backing,
    creditRaw: plan.creditRaw,
    limit: plan.limit,
    cash: data.cash,
    apyNow,
    enabled: onCashStep && !plan.block,
  });
  const quote = toCashQuote({
    plan,
    debtUsd: data.debtUsd,
    cashApy: aprToApy(data.savingsApr),
    creditApyNow: apyNow,
    creditApyAfter: rates.apyAfter,
  });

  const blocker = pickGone
    ? "That stock can’t back credit right now."
    : amount > reachUsd + 1e-9
      ? overReach(chosen, reachUsd)
      : amount > 0 && plan.block
        ? CREDIT_BLOCKED[plan.block]
        : null;
  const ready = amount > 0 && !blocker && quote.cost !== null;
  const feeBlocked = isConnected && fee.state === "unsupported";
  const signable =
    open && onCashStep && ready && !feeBlocked && !(plan.extraConfirm && !ack)
      ? { user, quote, confirmedRisk: ack }
      : null;
  const tx = useTx(TO_CASH_FAILED, signable ? toCashPlan(signable, cashToSign) : null);

  // Once it lands, Home on the re-read cash, and the toast says it's earning. Once per batch.
  const router = useRouter();
  const landed = useRef(false);
  useEffect(() => {
    if (tx.phase !== "done" || landed.current || !onCashStep) return;
    landed.current = true;
    onClose();
    router.push("/home");
    toast.success(earnDone(quote.amountUsd));
  }, [tx.phase, onCashStep, onClose, router, quote.amountUsd]);

  return {
    quote,
    blocker,
    ready,
    feeBlocked,
    feeLoading: fee.loading,
    isConnected,
    signable: !!signable,
    tx,
  };
}

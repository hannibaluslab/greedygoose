"use client";

import { useMemo } from "react";
import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { useAgents } from "@/hooks/useAgents";
import { useDebounced } from "@/hooks/useBuyQuote";
import { useBackingFactorsRead, type PositionData } from "@/hooks/usePosition";
import { useSigningCash } from "@/hooks/useSigningCash";
import { useTx } from "@/hooks/useTx";
import { AAVE } from "@/lib/aave/addresses";
import { hubAbi } from "@/lib/aave/abis/IHub";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { aprToApy, creditApr } from "@/lib/aave/math";
import type { Cash } from "@/lib/cash";
import { CHAIN_ID } from "@/lib/chain";
import { backingOptions, type Backing, type CreditLimit } from "@/lib/creditBuy";
import { buildEarnCalls, earnOffer } from "@/lib/earnWithStocks";
import { USDC } from "@/lib/tokens/registry";
import { earnPlan, type EarnInput } from "@/lib/tx/plans";

/**
 * Whether the Cash sheet offers Earn with stocks (earnOffer), on live data only: the cash rate and the credit's (each
 * an APY), the stocks that can back credit (paused and frozen ones left out), the position and the cash. No agent is
 * needed: the batch puts the credit where the cash earns itself. Also Protect's state for the risk line.
 */
export function useEarnOffer(account: `0x${string}`, data: PositionData, open: boolean) {
  const agents = useAgents(account);
  const { cfs, failed } = useBackingFactorsRead(open ? data.holdings : undefined);
  const options = useMemo(() => (cfs ? backingOptions(data.holdings, cfs) : undefined), [cfs, data.holdings]);
  const offer = earnOffer({
    cashApy: aprToApy(data.savingsApr),
    creditApy: aprToApy(data.apr),
    position: data,
    options,
    cash: data.cash,
    unread: failed,
  });
  return { offer, options: options ?? [], protect: agents.status.protect, sell: agents.status.sell };
}

/**
 * What credit costs once this batch lands, as an APY: the batch simulated from the user (eth_simulateV1) with the
 * account's risk premium and the Hub's drawn rate read after it, 400 ms after the amount or the backing stops changing.
 * `apyAfter` is null while it's read; if the read fails it's today's rate (the batch is simulated again before JAW's
 * sheet).
 */
export function useEarnRates(p: {
  user: `0x${string}`;
  backing: readonly Backing[];
  creditRaw: bigint;
  /** The plan's limit (CreditPlan.limit): the batch is held to it. */
  limit: CreditLimit;
  cash: Cash;
  apyNow: number;
  enabled?: boolean;
}) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const key = `${p.creditRaw}|${p.backing.map((b) => `${b.stock.symbol}:${b.raw}`).join(",")}`;
  const settled = useDebounced(key, 400);
  const q = useQuery({
    queryKey: ["earnRates", p.user, key],
    enabled: (p.enabled ?? true) && !!client && p.creditRaw > 0n && settled === key,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      const calls = buildEarnCalls({
        user: p.user,
        backing: p.backing,
        creditRaw: p.creditRaw,
        limit: p.limit,
        cash: p.cash,
      });
      const r = await client!.simulateCalls({
        account: p.user,
        calls: [
          ...calls.map(({ to, data }) => ({ to, data })),
          { to: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserLastRiskPremium", args: [p.user] },
          { to: AAVE.HUB, abi: hubAbi, functionName: "getAssetDrawnRate", args: [BigInt(USDC.reserveId)] },
        ],
      });
      if (r.results.some((x) => x.status !== "success")) throw new Error("The batch wouldn't go through");
      const [premium, drawn] = r.results.slice(-2).map((x) => x.result as bigint);
      return aprToApy(creditApr(drawn, premium));
    },
  });
  if (p.creditRaw <= 0n) return { apyAfter: p.apyNow };
  return { apyAfter: q.isError ? p.apyNow : settled === key && q.data !== undefined ? q.data : null };
}

const EARN_FAILED = "Earn with stocks didn’t go through on Base. Nothing moved except any network fee.";
/**
 * Earn with stocks' one write, through useTx. The earn step holds the amount, so it prepares the batch
 * (`usePrepare(tx.prep, tx.planFor(input))`) and its tap signs the same plan (`tx.sign(tx.planFor(input))`), straight
 * to JAW's sheet.
 */
export function useEarnWithStocks() {
  const tx = useTx(EARN_FAILED);
  const cashToSign = useSigningCash();
  return { ...tx, planFor: (p: EarnInput) => earnPlan(p, cashToSign) };
}

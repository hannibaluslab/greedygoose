"use client";

import { useMemo } from "react";
import { isAddressEqual, zeroAddress } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { useAgents } from "@/hooks/useAgents";
import { useDebounced } from "@/hooks/useBuyQuote";
import { useNowSec } from "@/hooks/useNowSec";
import { useCollateralFactors, type PositionData } from "@/hooks/usePosition";
import { useSigningCash } from "@/hooks/useSigningCash";
import { TxStop, useTx } from "@/hooks/useTx";
import { AAVE } from "@/lib/aave/addresses";
import { hubAbi } from "@/lib/aave/abis/IHub";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { aprToApy, borrowApr } from "@/lib/aave/math";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import type { AgentStatus } from "@/lib/agents/status";
import { CHAIN_ID } from "@/lib/chain";
import { backingOptions, type Backing } from "@/lib/creditBuy";
import { buildEarnCalls, earnActivity, earnOffer, earnStop, type EarnOpen, type EarnQuote, type SaveRoomInput } from "@/lib/earnWithStocks";
import { USDC } from "@/lib/tokens/registry";

/**
 * What Save can move today (lib/earnWithStocks.ts saveRoomRaw): what's left of the Save grant's daily limit
 * (useAgents' `left`, the manager's period), and the executor's own numbers and count, read while the sheet is open.
 * Null until it's all read, or while Save isn't on (there's no period to read).
 */
function useSaveRoom(account: `0x${string}`, walletRaw: bigint, enabled: boolean, left: ReturnType<typeof useAgents>["left"]): SaveRoomInput | null {
  const at = GOOSE_EXECUTOR ?? zeroAddress;
  const reads = useReadContracts({
    contracts: [
      { address: at, abi: gooseExecutorAbi, functionName: "accounts", args: [account], chainId: CHAIN_ID },
      { address: at, abi: gooseExecutorAbi, functionName: "amounts", chainId: CHAIN_ID },
    ],
    allowFailure: false,
    query: { enabled: enabled && !!GOOSE_EXECUTOR, refetchInterval: 20_000 },
  });
  const nowSec = useNowSec();
  const leftRaw = left.save?.find((s) => isAddressEqual(s.token as `0x${string}`, USDC.address))?.leftRaw;
  if (!reads.data || leftRaw === undefined || !nowSec) return null;
  const [acc, amounts] = reads.data;
  return {
    leftRaw,
    walletRaw,
    keepBackRaw: amounts[2],
    minSaveRaw: amounts[1],
    savesDay: acc[4],
    savesToday: acc[5],
    maxSavesPerDay: amounts[4],
    nowSec,
  };
}

/**
 * Whether the Cash sheet offers Earn with stocks (earnOffer), on live data only: earning's state, the cash rate and
 * the credit's (each an APY), the stocks that can back credit (paused and frozen ones left out), the position, the
 * cash and what Save can move today. Also Protect's state for the risk line, and the executor's CAP_MAX.
 */
export function useEarnOffer(account: `0x${string}`, data: PositionData, save: AgentStatus, open: boolean) {
  const agents = useAgents(account);
  const cfs = useCollateralFactors(open ? data.holdings : undefined);
  const options = useMemo(() => (cfs ? backingOptions(data.holdings, cfs) : undefined), [cfs, data.holdings]);
  const room = useSaveRoom(account, data.cash.walletRaw, open && save === "on", agents.left);
  const offer = earnOffer({
    save,
    cashApy: aprToApy(data.savingsApr),
    creditApy: aprToApy(data.apr),
    position: data,
    options,
    cash: data.cash,
    room,
  });
  return { offer, options: options ?? [], protect: agents.status.protect, sell: agents.status.sell, capMaxRaw: agents.capMaxRaw };
}

/**
 * What credit costs once this batch lands, as an APY: the batch simulated from the user (eth_simulateV1) with the
 * account's risk premium and the Hub's drawn rate read after it, 400 ms after the amount or the backing stops changing.
 * `apyAfter` is null while it's read; if the read fails it's today's rate (the batch is simulated again before JAW's
 * sheet).
 */
export function useEarnRates(p: { user: `0x${string}`; backing: readonly Backing[]; creditRaw: bigint; apyNow: number; enabled?: boolean }) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const key = `${p.creditRaw}|${p.backing.map((b) => `${b.stock.symbol}:${b.raw}`).join(",")}`;
  const settled = useDebounced(key, 400);
  const q = useQuery({
    queryKey: ["earnRates", p.user, key],
    enabled: (p.enabled ?? true) && !!client && p.creditRaw > 0n && settled === key,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      const calls = buildEarnCalls({ user: p.user, backing: p.backing, creditRaw: p.creditRaw });
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
      return aprToApy(borrowApr(drawn, premium));
    },
  });
  if (p.creditRaw <= 0n) return { apyAfter: p.apyNow };
  return { apyAfter: q.isError ? p.apyNow : settled === key && q.data !== undefined ? q.data : null };
}

export const EARN_FAILED = "Earn with stocks didn’t go through on Base. Nothing moved except any network fee.";
export const EARN_REVERT = "This would fail right now. Stock prices may be paused or have moved. Try a smaller amount in a moment.";

/**
 * Earn with stocks' one write, through useTx: the screen's stops are checked again at the tap (earnStop), the cash is
 * read again for the network fee, then the batch is built, checked (assertEarn), simulated and sent to JAW's sheet.
 */
export function useEarnWithStocks() {
  const tx = useTx(EARN_FAILED);
  const cashToSign = useSigningCash();
  const earn = (p: { user: `0x${string}`; quote: EarnQuote; offer: EarnOpen; confirmedRisk: boolean }) =>
    tx.run(
      p.user,
      async () => {
        const stop = earnStop(p.quote, p.offer, p.confirmedRisk);
        if (stop) throw new TxStop(stop);
        await cashToSign(p.user, 0n);
        return buildEarnCalls({ user: p.user, backing: p.quote.plan.backing, creditRaw: p.quote.plan.creditRaw });
      },
      EARN_REVERT,
      earnActivity(p.quote.plan),
    );
  return { ...tx, earn };
}

"use client";

import { zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import type { HeadsUp } from "@/hooks/useAgentFeed";
import type { useAgentSettings } from "@/hooks/useAgentSettings";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { summarize } from "@/lib/aave/math";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { timeText, type HeadsUpCard } from "@/lib/agents/list";
import { toUsd } from "@/lib/cash";
import { CHAIN_ID } from "@/lib/chain";
import { statusFor } from "@/lib/risk/status";

/**
 * Protect · sell's pending heads-up, as its card says it. It shows only while the registry's `headsUpAt` is that
 * heads-up's time (a sale cut short, or one cleared, has moved it), and only while the credit is in Act, under the
 * executor's heads-up line: back above it the executor clears the heads-up on its next run and sells nothing (Act is
 * the line, 2026-10-15). "Add $X" is the repay that brings the credit back to
 * Protect · sell's target (read live), rounded up so it's enough; "$Y" is the stock the heads-up said it would sell.
 * When its wait ends while prices are held, the heads-up's `sellAfter` is the moment they reopen: the second before it
 * is frozen. It reads only the spoke's account data, so the warning never waits on the rest of the account.
 */
export function useHeadsUp(
  account: `0x${string}`,
  sale: HeadsUp | null,
  settings: ReturnType<typeof useAgentSettings>,
  nowSec: number,
): HeadsUpCard | null {
  const headsUpAt = settings?.headsUpAt ?? 0;
  const pending = sale && headsUpAt !== 0 && sale.sentAt === headsUpAt ? sale : null;
  const reads = useReadContracts({
    contracts: [
      { address: GOOSE_EXECUTOR ?? zeroAddress, abi: gooseExecutorAbi, functionName: "frozen", args: [BigInt((pending?.sellAfter ?? 1) - 1)], chainId: CHAIN_ID },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [account], chainId: CHAIN_ID },
    ],
    allowFailure: false,
    query: { enabled: !!GOOSE_EXECUTOR && !!pending, refetchInterval: 20_000 },
  });
  if (!pending || !settings || !reads.data) return null;
  const [reopens, data] = reads.data;
  const credit = summarize(data);
  const hf = credit.healthFactor;
  if (statusFor(hf) !== "act" || hf === null || hf >= settings.sellHeadsUpHf) return null;
  const addUsd = Math.ceil(credit.debtUsd - (credit.collateralUsd * credit.avgCf) / settings.sellTargetHf);
  if (addUsd <= 0) return null;
  const when = pending.sellAfter <= nowSec ? "now" : reopens ? "when prices reopen" : `at ${timeText(pending.sellAfter)}`;
  return { addUsd, sellUsd: toUsd(pending.sellValueRaw), when };
}

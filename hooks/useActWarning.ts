"use client";

import { useReadContract } from "wagmi";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { summarize } from "@/lib/aave/math";
import type { ActCard } from "@/lib/agents/list";
import { actWarning, type RuleNumbers } from "@/lib/agents/next";
import { CHAIN_ID } from "@/lib/chain";

/**
 * The Act warning's card (Adrian, 2026-10-19): a plain health check of the credit under Act's line (1.1), down to
 * Protect's (1.03, the executor's live `triggerHf`) while Protect is on, which acts under it on its own, and all the
 * way down while it is off. It reads only the spoke's account data, so the warning never waits on the rest of the
 * account.
 *
 * This is the in-app half. The push for the same warning is sent by the runner, which lives outside this repo.
 */
export function useActWarning(
  account: `0x${string}`,
  numbers: Pick<RuleNumbers, "triggerHf" | "targetHf">,
  protectOn: boolean,
): ActCard | null {
  const read = useReadContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "getUserAccountData",
    args: [account],
    chainId: CHAIN_ID,
    query: { refetchInterval: 20_000 },
  });
  if (!read.data) return null;
  const credit = summarize(read.data);
  return actWarning({
    healthFactor: credit.healthFactor,
    totalBackingUsd: credit.totalBackingUsd,
    avgCf: credit.avgCf,
    debtUsd: credit.debtUsd,
    numbers,
    protectOn,
  });
}

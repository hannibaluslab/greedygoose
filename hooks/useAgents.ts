"use client";

import { useMemo } from "react";
import { useReadContract } from "wagmi";
import { useGrantPermissions, usePermissions, useRevokePermissions } from "@jaw.id/wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { agentGrant, dailyLimitRaw, JOBS, readAgentGrant, type AgentGrant, type AgentJob } from "@/lib/agents/permissions";
import { jobStatus, type AgentStatus } from "@/lib/agents/status";
import { useNowSec } from "@/hooks/useNowSec";

/** A grant lasts a year, like Guardian's. */
const GRANT_SECONDS = 365 * 86_400;

/**
 * One account's agents, through JAW's own permission screens (D14): turned on with `useGrantPermissions`, listed
 * with `usePermissions` and turned off with `useRevokePermissions`, always with GooseExecutor as the spender. The
 * app sends no raw `manager.approve` or `addOwnerAddress`. Whether a job runs comes from the executor's registry
 * (`jobsOf`), so the switches survive cleared browser storage.
 */
export function useAgents(account: `0x${string}`) {
  const executor = GOOSE_EXECUTOR;
  const listed = usePermissions({ address: account, chainId: CHAIN_ID, query: { enabled: !!executor } });
  const registry = useReadContract({
    address: executor,
    abi: gooseExecutorAbi,
    functionName: "jobsOf",
    args: [account],
    chainId: CHAIN_ID,
    query: { enabled: !!executor, refetchInterval: 20_000 },
  });
  // Immutable: the most any daily limit may be on this executor (a grant above it never registers).
  const capMax = useReadContract({
    address: executor,
    abi: gooseExecutorAbi,
    functionName: "CAP_MAX",
    chainId: CHAIN_ID,
    query: { enabled: !!executor, staleTime: Infinity },
  });
  const grant = useGrantPermissions();
  const revoke = useRevokePermissions();
  const nowSec = useNowSec();

  /** Our grants in JAW's list. */
  const granted = useMemo(
    () => (executor ? (listed.data ?? []).map((p) => readAgentGrant(p, executor)).filter((g): g is AgentGrant => !!g) : []),
    [executor, listed.data],
  );

  const status = useMemo(
    () =>
      Object.fromEntries(
        JOBS.map((job): [AgentJob, AgentStatus] => [
          job,
          !executor
            ? "unconfigured"
            : registry.isLoading || listed.isLoading || !registry.data
              ? "loading"
              : jobStatus(job, registry.data, granted, nowSec, listed.isError),
        ]),
      ) as Record<AgentJob, AgentStatus>,
    [executor, registry.isLoading, registry.data, listed.isLoading, listed.isError, granted, nowSec],
  );

  const refetch = () => Promise.all([listed.refetch(), registry.refetch()]);

  /** One JAW screen and one Face ID per job: a grant request carries one permission. */
  async function turnOn(job: AgentJob, capRaw: bigint) {
    if (!executor) throw new Error("Agents aren't available yet");
    await grant.mutateAsync({
      address: account,
      chainId: CHAIN_ID,
      expiry: Math.floor(Date.now() / 1000) + GRANT_SECONDS,
      spender: executor,
      permissions: agentGrant(job, capRaw),
    });
    await refetch();
  }

  /** Revokes every grant JAW lists for the job, so nothing is left for the executor to use. */
  async function turnOff(job: AgentJob) {
    for (const g of granted.filter((g) => g.job === job)) {
      await revoke.mutateAsync({ address: account, chainId: CHAIN_ID, id: g.permissionId });
    }
    await refetch();
  }

  const [, save, protect, fails] = registry.data ?? [];
  return {
    status,
    /** The daily limit each job runs with, in USDC units, once it's on. */
    capRaw: { save: status.save === "on" ? save!.cap : null, protect: status.protect === "on" ? protect!.cap : null },
    /** The daily limit a job is switched on with (`turnOn`), once the executor's CAP_MAX is read. */
    limitRaw: Object.fromEntries(JOBS.map((job) => [job, capMax.data === undefined ? null : dailyLimitRaw(job, capMax.data)])) as Record<
      AgentJob,
      bigint | null
    >,
    /** Failed runs in a row: the executor backs off, then switches the account off at eight. */
    fails: fails ?? 0,
    busy: grant.isPending || revoke.isPending,
    error: grant.error ?? revoke.error,
    turnOn,
    turnOff,
    refetch,
  };
}

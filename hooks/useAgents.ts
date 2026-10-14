"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useGrantPermissions, usePermissions, useRevokePermissions } from "@jaw.id/wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import {
  JOBS,
  jobGrant,
  readAgentGrant,
  readStockLimits,
  type AgentGrant,
  type AgentJob,
  type StockLimits,
} from "@/lib/agents/permissions";
import { jobStatus, type AgentStatus, type Stored } from "@/lib/agents/status";
import { useNowSec } from "@/hooks/useNowSec";

/** A grant lasts a year, like Guardian's. */
const GRANT_SECONDS = 365 * 86_400;

/** The jobs whose stored grant only `permissionOf` returns: `jobsOf` carries Save's and Protect's. */
const LATER_JOBS = ["sell", "rebalance", "entry"] as const;

/** What a job runs with: its limit, and for Protect · sell and the Rebalancer each stock's. */
export type JobTerms = { capRaw: bigint; limitsRaw?: StockLimits };

/**
 * One account's agents, through JAW's own permission screens (D14): turned on with `useGrantPermissions`, listed
 * with `usePermissions` and turned off with `useRevokePermissions`, always with GooseExecutor as the spender. The
 * app sends no raw `manager.approve` or `addOwnerAddress`. Whether a job runs comes from the executor's registry
 * (`jobsOf`, and `permissionOf` for the jobs after the Cash Agent's), so the switches survive cleared browser storage.
 */
export function useAgents(account: `0x${string}`) {
  const executor = GOOSE_EXECUTOR;
  const listed = usePermissions({ address: account, chainId: CHAIN_ID, query: { enabled: !!executor } });
  const at = executor ?? zeroAddress; // the reads stay off until the executor is configured
  const stockOf = (job: (typeof LATER_JOBS)[number]) =>
    ({ address: at, abi: gooseExecutorAbi, functionName: "permissionOf", args: [account, JOBS.indexOf(job)], chainId: CHAIN_ID }) as const;
  const registry = useReadContracts({
    contracts: [
      { address: at, abi: gooseExecutorAbi, functionName: "jobsOf", args: [account], chainId: CHAIN_ID },
      stockOf(LATER_JOBS[0]),
      stockOf(LATER_JOBS[1]),
      stockOf(LATER_JOBS[2]),
    ],
    allowFailure: false,
    query: { enabled: !!executor, refetchInterval: 20_000 },
  });
  // Immutable: the most any limit may be on this executor (a grant above it never registers).
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

  /** The registry: the job bits, failures in a row, and each job's stored grant (with its stock limits). */
  const stored = useMemo(() => {
    if (!registry.data) return undefined;
    const [[jobs, save, protect, fails], ...later] = registry.data;
    const grants = { save, protect } as Record<AgentJob, Stored & { limitsRaw?: StockLimits }>;
    LATER_JOBS.forEach((job, i) => {
      const p = later[i];
      const limitsRaw = job === "entry" ? undefined : (readStockLimits(job, p.spends) ?? undefined);
      grants[job] = { start: p.start, end: p.end, cap: p.spends[0]?.allowance ?? 0n, limitsRaw };
    });
    return { jobs, fails, grants };
  }, [registry.data]);

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
            : registry.isLoading || listed.isLoading || !stored
              ? "loading"
              : jobStatus(job, stored.jobs, stored.grants[job], granted, nowSec, listed.isError),
        ]),
      ) as Record<AgentJob, AgentStatus>,
    [executor, registry.isLoading, stored, listed.isLoading, listed.isError, granted, nowSec],
  );

  /** What each job runs with: the registry's grant once it's on, the newest one JAW lists while it's starting. */
  const terms = useMemo(
    () =>
      Object.fromEntries(
        JOBS.map((job): [AgentJob, JobTerms | null] => {
          if (status[job] === "on" && stored) return [job, { capRaw: stored.grants[job].cap, limitsRaw: stored.grants[job].limitsRaw }];
          if (status[job] !== "starting") return [job, null];
          const newest = granted.filter((g) => g.job === job && g.end >= nowSec).sort((a, b) => b.start - a.start)[0];
          return [job, { capRaw: newest.capRaw, limitsRaw: newest.limitsRaw }];
        }),
      ) as Record<AgentJob, JobTerms | null>,
    [status, stored, granted, nowSec],
  );

  const refetch = () => Promise.all([listed.refetch(), registry.refetch()]);

  /**
   * One JAW screen and one Face ID per job: a grant request carries one permission. Protect · sell and the Rebalancer
   * take a limit per stock as well (`stockLimitsRaw`).
   */
  async function turnOn(job: AgentJob, capRaw: bigint, limitsRaw?: StockLimits) {
    if (!executor) throw new Error("Agents aren't available yet");
    await grant.mutateAsync({
      address: account,
      chainId: CHAIN_ID,
      expiry: Math.floor(Date.now() / 1000) + GRANT_SECONDS,
      spender: executor,
      permissions: jobGrant(job, capRaw, limitsRaw),
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

  return {
    status,
    terms,
    /** The most any limit may be on this executor, once read. */
    capMaxRaw: capMax.data ?? null,
    /** Failed runs in a row: the executor backs off, then switches the account off at eight. */
    fails: stored?.fails ?? 0,
    busy: grant.isPending || revoke.isPending,
    error: grant.error ?? revoke.error,
    turnOn,
    turnOff,
    refetch,
  };
}

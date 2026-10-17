"use client";

import { useMemo } from "react";
import { isAddressEqual, zeroAddress } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useGrantPermissions, usePermissions, useRevokePermissions } from "@jaw.id/wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import type { SpendLeft } from "@/lib/agents/next";
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
import { GUARDIAN } from "@/lib/guardian/config";
import { permissionManagerAbi } from "@/lib/guardian/abis";
import { useNowSec } from "@/hooks/useNowSec";

/** A grant lasts a year, like Guardian's. */
export const GRANT_SECONDS = 365 * 86_400;

/** What a job runs with: its limit, and for Protect · sell and the Rebalancer each stock's. */
type JobTerms = { capRaw: bigint; limitsRaw?: StockLimits };

const byJob = <T>(f: (job: AgentJob) => T) =>
  Object.fromEntries(JOBS.map((job) => [job, f(job)])) as Record<AgentJob, T>;

/**
 * Grants revoked this session (JAW permission ids), shared by every screen's useAgents until JAW's list shows them
 * gone: a turn-off that stopped part way on one screen goes on with the rest from any other, and isn't counted again.
 */
const revoked = new Set<string>();

/**
 * One account's agents, through JAW's own permission screens (D14): turned on with `useGrantPermissions`, listed
 * with `usePermissions` and turned off with `useRevokePermissions`, always with GooseExecutor as the spender. The
 * app sends no raw `manager.approve` or `addOwnerAddress`. Whether a job runs comes from the executor's registry
 * (`jobsOf`, and each job's `permissionOf`), so the switches survive cleared browser storage.
 */
export function useAgents(account: `0x${string}`) {
  const executor = GOOSE_EXECUTOR;
  const listed = usePermissions({ address: account, chainId: CHAIN_ID, query: { enabled: !!executor } });
  const at = executor ?? zeroAddress; // the reads stay off until the executor is configured
  const permissionOf = (id: number) =>
    ({
      address: at,
      abi: gooseExecutorAbi,
      functionName: "permissionOf",
      args: [account, id],
      chainId: CHAIN_ID,
    }) as const;
  const registry = useReadContracts({
    contracts: [
      { address: at, abi: gooseExecutorAbi, functionName: "jobsOf", args: [account], chainId: CHAIN_ID },
      permissionOf(0),
      permissionOf(1),
      permissionOf(2),
      permissionOf(3),
      permissionOf(4),
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
  const { address: signer } = useAccount();
  const nowSec = useNowSec();

  /** Grants and revokes are the account's own, like useTx's calls: never while another address is shown (`?as=`). */
  function ownAccount() {
    if (!signer || !isAddressEqual(signer, account)) throw new Error("Only the signed-in account can do this");
  }

  /** The registry: the job bits, failures in a row and the back-off, and each job's stored grant (with its stock limits). */
  const stored = useMemo(() => {
    if (!registry.data) return undefined;
    const [[jobs, , , fails, cooldownUntil], ...permissions] = registry.data;
    const grants = byJob((job): Stored & { limitsRaw?: StockLimits } => {
      const p = permissions[JOBS.indexOf(job)];
      const limitsRaw =
        job === "sell" || job === "rebalance" ? (readStockLimits(job, p.spends) ?? undefined) : undefined;
      return { start: p.start, end: p.end, cap: p.spends[0]?.allowance ?? 0n, limitsRaw };
    });
    return { jobs, fails, cooldownUntil: Number(cooldownUntil), grants, permissions };
  }, [registry.data]);

  /** Our grants in JAW's list. */
  const granted = useMemo(
    () =>
      executor ? (listed.data ?? []).map((p) => readAgentGrant(p, executor)).filter((g): g is AgentGrant => !!g) : [],
    [executor, listed.data],
  );

  const status = useMemo(
    () =>
      byJob(
        (job): AgentStatus =>
          !executor
            ? "unconfigured"
            : registry.isLoading || listed.isLoading || !stored
              ? "loading"
              : jobStatus(job, stored.jobs, stored.grants[job], granted, nowSec, listed.isError),
      ),
    [executor, registry.isLoading, stored, listed.isLoading, listed.isError, granted, nowSec],
  );

  /** Each job's grants JAW lists that haven't ended, newest first. */
  const live = useMemo(
    () => byJob((job) => granted.filter((g) => g.job === job && g.end >= nowSec).sort((a, b) => b.start - a.start)),
    [granted, nowSec],
  );

  /** What each job runs with: the registry's grant once it's on, the newest one JAW lists while it's starting. */
  const terms = useMemo(
    () =>
      byJob((job): (JobTerms & { end: number }) | null => {
        if (status[job] === "on" && stored) {
          const g = stored.grants[job];
          return { capRaw: g.cap, limitsRaw: g.limitsRaw, end: g.end };
        }
        if (status[job] !== "starting") return null;
        const newest = live[job][0];
        return { capRaw: newest.capRaw, limitsRaw: newest.limitsRaw, end: newest.end };
      }),
    [status, stored, live],
  );

  /**
   * When a job stopped without being revoked: its newest grant, in JAW's list or the registry, ran out. A grant the
   * user revoked leaves JAW's list, so it never counts.
   */
  const ranOut = useMemo(
    () =>
      byJob((job): number | null => {
        if (status[job] !== "off") return null;
        const ended = [
          ...granted.filter((g) => g.job === job).map((g) => g.end),
          ...(stored && (stored.jobs & (1 << JOBS.indexOf(job))) !== 0 ? [stored.grants[job].end] : []),
        ].filter((end) => end > 0 && end < nowSec);
        return ended.length ? Math.max(...ended) : null;
      }),
    [status, granted, stored, nowSec],
  );

  /**
   * The terms a job last ran with, to renew it: its newest grant in JAW's list, else the registry's; null if it never
   * had one.
   */
  const lastTerms = useMemo(
    () =>
      byJob((job): JobTerms | null => {
        const newest = granted.filter((g) => g.job === job).sort((a, b) => b.start - a.start)[0];
        if (newest) return { capRaw: newest.capRaw, limitsRaw: newest.limitsRaw };
        const g = stored?.grants[job];
        return g && g.cap > 0n ? { capRaw: g.cap, limitsRaw: g.limitsRaw } : null;
      }),
    [granted, stored],
  );

  // What each running job's limits still allow this period: the manager's count against the grant the executor runs.
  const spends = useMemo(
    () =>
      stored
        ? JOBS.filter((job) => status[job] === "on").flatMap((job) => {
            const permission = stored.permissions[JOBS.indexOf(job)];
            return permission.spends.map((spend) => ({ job, permission, spend }));
          })
        : [],
    [stored, status],
  );
  const periods = useReadContracts({
    contracts: spends.map(({ permission, spend }) => ({
      address: GUARDIAN.PERMISSION_MANAGER,
      abi: permissionManagerAbi,
      functionName: "getCurrentPeriod",
      args: [permission, spend],
      chainId: CHAIN_ID,
    })),
    allowFailure: false,
    query: { enabled: spends.length > 0, refetchInterval: 20_000 },
  });
  const left = useMemo(
    () =>
      byJob((job): SpendLeft[] | null => {
        if (!periods.data || !spends.some((s) => s.job === job)) return null;
        return spends.flatMap(({ job: j, spend }, k) => {
          if (j !== job) return [];
          const used = (periods.data[k] as { spend: bigint }).spend;
          return [{ token: spend.token, leftRaw: spend.allowance > used ? spend.allowance - used : 0n }];
        });
      }),
    [periods.data, spends],
  );

  const refetch = () => Promise.all([listed.refetch(), registry.refetch()]);

  /**
   * One JAW sheet per job: a grant request carries one permission. Protect · sell and the Rebalancer
   * take a limit per stock as well (`stockLimitsRaw`). The request is built here, synchronously from the tap, and
   * JAW's grant is called before anything is awaited (Safari opens JAW's popup only inside the tap's activation).
   */
  async function turnOn(job: AgentJob, capRaw: bigint, limitsRaw?: StockLimits) {
    if (!executor) throw new Error("Agents aren't available yet");
    ownAccount();
    const request = {
      address: account,
      chainId: CHAIN_ID,
      expiry: Math.floor(Date.now() / 1000) + GRANT_SECONDS,
      spender: executor,
      permissions: jobGrant(job, capRaw, limitsRaw),
    };
    await grant.mutateAsync(request);
    await refetch();
  }

  /**
   * Revokes every grant JAW lists for the job that hasn't ended, so nothing is left for the executor to use. The first
   * revoke is called straight from the tap; one that stops part way (cancelled, or a sheet JAW couldn't open) leaves
   * the rest for the next try, which skips those already revoked.
   */
  async function turnOff(job: AgentJob) {
    ownAccount();
    try {
      for (const g of live[job]) {
        if (revoked.has(g.permissionId)) continue;
        await revoke.mutateAsync({ address: account, chainId: CHAIN_ID, id: g.permissionId });
        revoked.add(g.permissionId);
      }
    } finally {
      await refetch();
    }
  }

  return {
    status,
    terms,
    ranOut,
    lastTerms,
    left,
    /** What's left of the running jobs' limits couldn't be read (`left` stays null until it is). */
    leftUnreadable: periods.isError && !periods.data,
    /** JAW sheets it takes to turn `jobs` off: one per grant JAW lists for them that hasn't ended. */
    faceIdsOff: (jobs: readonly AgentJob[]) =>
      jobs.reduce((n, job) => n + live[job].filter((g) => !revoked.has(g.permissionId)).length, 0),
    /** The most any limit may be on this executor, once read. */
    capMaxRaw: capMax.data ?? null,
    /** The registry couldn't be read (every status stays "loading" until it is). */
    unreadable: registry.isError && !registry.data,
    /** Failed runs in a row, and when the executor tries again: it backs off, then switches the account off at eight. */
    fails: stored?.fails ?? 0,
    cooldownUntil: stored?.cooldownUntil ?? 0,
    busy: grant.isPending || revoke.isPending,
    error: grant.error ?? revoke.error,
    turnOn,
    turnOff,
    refetch,
  };
}

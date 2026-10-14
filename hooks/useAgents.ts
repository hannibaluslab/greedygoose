"use client";

import { useMemo } from "react";
import { zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useGrantPermissions, usePermissions, useRevokePermissions } from "@jaw.id/wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import {
  agentGrant,
  dailyLimitRaw,
  EXECUTOR_JOBS,
  JOBS,
  readAgentGrant,
  type AgentGrant,
  type AgentJob,
  type ExecutorJob,
} from "@/lib/agents/permissions";
import { jobStatus, type AgentStatus, type Registry } from "@/lib/agents/status";
import { useNowSec } from "@/hooks/useNowSec";

/** A grant lasts a year, like Guardian's. */
const GRANT_SECONDS = 365 * 86_400;

/** GooseExecutor's `accounts(account)`: the registry's slot for one account. */
type AccountSlot = readonly [
  jobs: number,
  index: number,
  fails: number,
  cooldownUntil: number,
  savesDay: number,
  savesToday: number,
  headsUpAt: number,
  keepMix: boolean,
  rebalanceDay: number,
];
type StoredPermission = { start: number; end: number; spends: readonly { allowance: bigint }[] };

/** The Rebalancer's target mix as the registry packs it: a weight in BPS per stock, 16 bits each by reserve id. */
const unpackMix = (mix: bigint) => Array.from({ length: 7 }, (_, r) => (mix >> BigInt(16 * r)) & 0xffffn);

/**
 * One account's agents, through JAW's own permission screens (D14): turned on with `useGrantPermissions`, listed
 * with `usePermissions` and turned off with `useRevokePermissions`, always with GooseExecutor as the spender. The
 * app sends no raw `manager.approve` or `addOwnerAddress`. Whether a job runs comes from the executor's registry
 * (`accounts` and each job's `permissionOf`), so the state survives cleared browser storage.
 */
export function useAgents(account: `0x${string}`) {
  const executor = GOOSE_EXECUTOR;
  const listed = usePermissions({ address: account, chainId: CHAIN_ID, query: { enabled: !!executor } });
  const contracts = useMemo(() => {
    // The query is disabled until an executor is configured.
    const read = { address: executor ?? zeroAddress, abi: gooseExecutorAbi, chainId: CHAIN_ID } as const;
    const permissionOf = (job: ExecutorJob) =>
      ({ ...read, functionName: "permissionOf", args: [account, EXECUTOR_JOBS.indexOf(job)] }) as const;
    // Each job's stored grant, in EXECUTOR_JOBS order.
    return [
      { ...read, functionName: "accounts", args: [account] },
      permissionOf("save"),
      permissionOf("protect"),
      permissionOf("sell"),
      permissionOf("rebalance"),
      permissionOf("entry"),
      { ...read, functionName: "mixes", args: [account] },
    ] as const;
  }, [executor, account]);
  const reads = useReadContracts({ contracts, allowFailure: false, query: { enabled: !!executor, refetchInterval: 20_000 } });
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

  const registry = useMemo(() => {
    const r = reads.data as readonly unknown[] | undefined;
    if (!r) return undefined;
    const slot = r[0] as AccountSlot;
    const stored = r.slice(1, 1 + EXECUTOR_JOBS.length) as StoredPermission[];
    const grants = Object.fromEntries(
      EXECUTOR_JOBS.map((job, j) => [job, { start: stored[j].start, end: stored[j].end, cap: stored[j].spends[0]?.allowance ?? 0n }]),
    ) as Registry["grants"];
    return { jobs: slot[0], grants, fails: slot[2], headsUpAt: slot[6], mixBps: unpackMix(r[1 + EXECUTOR_JOBS.length] as bigint) };
  }, [reads.data]);

  const status = useMemo(
    () =>
      Object.fromEntries(
        EXECUTOR_JOBS.map((job): [ExecutorJob, AgentStatus] => [
          job,
          !executor
            ? "unconfigured"
            : listed.isLoading || !registry
              ? "loading"
              : jobStatus(job, registry, granted, nowSec, listed.isError),
        ]),
      ) as Record<ExecutorJob, AgentStatus>,
    [executor, registry, listed.isLoading, listed.isError, granted, nowSec],
  );

  const refetch = () => Promise.all([listed.refetch(), reads.refetch()]);

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

  return {
    status,
    /** Each job's limit once it's on, in USDC units: a day's, or a week's for the Rebalancer. */
    capRaw: Object.fromEntries(
      EXECUTOR_JOBS.map((job) => [job, status[job] === "on" ? registry!.grants[job].cap : null]),
    ) as Record<ExecutorJob, bigint | null>,
    /** The daily limit a job is switched on with (`turnOn`), once the executor's CAP_MAX is read. */
    limitRaw: Object.fromEntries(JOBS.map((job) => [job, capMax.data === undefined ? null : dailyLimitRaw(job, capMax.data)])) as Record<
      AgentJob,
      bigint | null
    >,
    /** Failed runs in a row: the executor backs off, then switches the account off at eight. */
    fails: registry?.fails ?? 0,
    /** When Protect · sell's pending heads-up went out, in seconds; 0 when none is pending. */
    headsUpAt: registry?.headsUpAt ?? 0,
    /** The Rebalancer's target mix, a weight in BPS per stock by reserve id; all 0 when none is set. */
    mixBps: registry?.mixBps ?? null,
    busy: grant.isPending || revoke.isPending,
    error: grant.error ?? revoke.error,
    turnOn,
    turnOff,
    refetch,
  };
}

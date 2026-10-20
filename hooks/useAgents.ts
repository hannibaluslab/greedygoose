"use client";

import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isAddressEqual, zeroAddress } from "viem";
import {
  useAccount,
  useCapabilities,
  useConfig,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSendCalls,
} from "wagmi";
import { waitForCallsStatus } from "wagmi/actions";
import { useGrantPermissions, usePermissions, useRevokePermissions } from "@jaw.id/wagmi";
import type { ChainCapabilities } from "@jaw.id/core";
import type { Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import type { SpendLeft } from "@/lib/agents/next";
import {
  JOBS,
  grantPermission,
  jobGrant,
  listedFromGrant,
  readAgentGrant,
  readStockLimits,
  type AgentGrant,
  type AgentJob,
  type StockLimits,
} from "@/lib/agents/permissions";
import {
  AgentStop,
  OFF_UNREADABLE,
  jobStatus,
  offUnreadable,
  type AgentStatus,
  type Stored,
} from "@/lib/agents/status";
import { atomicSend, NOT_ATOMIC } from "@/lib/jaw/capabilities";
import { PROTOCOLS } from "@/lib/protocols/config";
import { permissionManagerAbi } from "@/lib/protocols/abis";
import { PREPARED_TTL_MS, chainEpoch, chainMoved, checkPlan, isPopupBlocked, type TxPlan } from "@/lib/tx/prepared";
import { registerPlan } from "@/lib/tx/plans";
import { useNowSec } from "@/hooks/useNowSec";
import { checkDeps } from "@/hooks/useTx";

/** A grant lasts a year. */
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
 * Grants JAW returned on this page, by account and job, until the executor registers them: their registration doesn't
 * wait for JAW's list to show them.
 */
const fresh = new Map<string, AgentGrant>();
const freshKey = (account: string, job: AgentJob) => `${account.toLowerCase()}:${job}`;

/**
 * The registry settings a change's last batch carried when it stopped before landing (blocked, cancelled, failed), by
 * account and job, so the Finish card completes the change as it was asked, not only its registrations. Forgotten once
 * the job runs, or when a later save sets them alone (`forgetSettings`).
 */
const stoppedSettings = new Map<string, readonly Call[]>();

/**
 * A registration JAW couldn't open (Safari opens its popup only inside a tap, and it comes after the grant's): its
 * checked batch, sent by the next tap that asks for the same before anything is awaited, under useTx's 30 s and only if
 * no write landed since.
 */
let kept: { key: string; batch: Call[]; at: number; epoch: number } | null = null;

/** Said when a change's last batch JAW sent didn't land: the grants stand, and the next try sends the batch again. */
const REGISTER_FAILED = "This didn’t go through on Base. Try again to finish turning it on.";

/** Times a registration is checked: the grant's block can reach Base's public node a moment after JAW's. */
const CHECKS = 3;
const CHECK_GAP_MS = 2_000;

const sameLimits = (a?: StockLimits, b?: StockLimits) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

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
  const client = usePublicClient({ chainId: CHAIN_ID });
  const caps = useCapabilities({ account: signer, query: { enabled: !!signer && !!executor } });
  const chainCaps = (caps.data as Record<number, ChainCapabilities> | undefined)?.[CHAIN_ID];
  const send = useSendCalls();
  const config = useConfig();
  const queryClient = useQueryClient();

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
      address: PROTOCOLS.PERMISSION_MANAGER,
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
   * Each job's newest grant the executor hasn't registered (JAW granted it, its registration is still to go): from JAW's
   * list or this page's own grants, not past its end, and not the one the registry holds.
   */
  const unregistered = useMemo(
    () =>
      byJob((job): AgentGrant | null => {
        const own = fresh.get(freshKey(account, job));
        const newest = [own, live[job][0]]
          .filter((g): g is AgentGrant => !!g && g.end >= nowSec)
          .sort((a, b) => b.start - a.start)[0];
        if (!newest || !stored) return null;
        const id = JOBS.indexOf(job);
        const registered = (stored.jobs & (1 << id)) !== 0 && stored.permissions[id].salt === newest.salt;
        return registered ? null : newest;
      }),
    [account, live, stored, nowSec],
  );

  /**
   * A job's grant waiting for its registration: this page's own while the registry doesn't hold it yet (JAW's list may
   * not show it yet, and the render's state may be older than the grant), else `unregistered`.
   */
  const waitingGrant = (job: AgentJob): AgentGrant | null => {
    const own = fresh.get(freshKey(account, job));
    const id = JOBS.indexOf(job);
    const held = !!stored && (stored.jobs & (1 << id)) !== 0 && stored.permissions[id].salt === own?.salt;
    return own && !held ? own : unregistered[job];
  };

  /**
   * The jobs granted but not running yet (status "starting"), and the batch that registers them all, with the settings
   * their stopped change carried (each once).
   */
  const toFinish = JOBS.filter((job) => status[job] === "starting" && unregistered[job]);
  const finishSettings = [
    ...new Map(
      toFinish.flatMap((job) => stoppedSettings.get(freshKey(account, job)) ?? []).map((c) => [c.data, c] as const),
    ).values(),
  ];
  const finishPlan: TxPlan | null =
    executor && toFinish.length > 0
      ? registerPlan(
          account,
          toFinish.map((job) => grantPermission(unregistered[job]!, account, executor)),
          finishSettings,
        )
      : null;

  // A job that runs with no grant waiting has nothing left to finish: its stopped change's settings are forgotten.
  useEffect(() => {
    for (const job of JOBS)
      if (status[job] === "on" && !unregistered[job]) stoppedSettings.delete(freshKey(account, job));
  }, [account, status, unregistered]);

  /** A registration's batch, checked like every write (useTx's checkPlan), a few times while the grant's block lands. */
  async function checked(plan: TxPlan): Promise<Call[]> {
    for (let i = 1; ; i++) {
      const r = await checkPlan(plan, checkDeps(client));
      if (r.ok) return r.batch;
      if (i === CHECKS) throw new AgentStop(r.error);
      await new Promise((ok) => setTimeout(ok, CHECK_GAP_MS));
    }
  }

  /**
   * A change's last batch on JAW's sheet: its registry `settings`, then one `registerApproved` per grant, the app's half
   * of turning a job on, since no runner watches the manager (runner switch plan, option 1). Checked and simulated
   * first, then JAW signs, then it waits for Base and reads the registry again. A sheet JAW couldn't open keeps its
   * batch (`kept`), and the next tap for the same change sends it before anything is awaited.
   */
  async function register(grants: readonly AgentGrant[], settings: readonly Call[] = []) {
    if (!executor) throw new Error("Agents aren't available yet");
    const plan = registerPlan(
      account,
      grants.map((g) => grantPermission(g, account, executor)),
      settings,
    );
    try {
      await sendBatch(plan);
      for (const g of grants) {
        fresh.delete(freshKey(account, g.job));
        stoppedSettings.delete(freshKey(account, g.job));
      }
    } catch (e) {
      // The batch that stopped is what the Finish card completes: its settings, or none.
      for (const g of grants) {
        if (settings.length > 0) stoppedSettings.set(freshKey(account, g.job), settings);
        else stoppedSettings.delete(freshKey(account, g.job));
      }
      throw e;
    }
  }

  /**
   * Sends a checked batch on JAW's sheet, the kept one when it's ready for the same change (nothing awaited before JAW
   * is called), then waits for Base. Landed: every read on the page is fetched again (the settings, the position), as
   * useTx does. Either way the registry and JAW's list are read again.
   */
  async function sendBatch(plan: TxPlan) {
    const ready =
      kept && kept.key === plan.key && Date.now() - kept.at < PREPARED_TTL_MS && kept.epoch === chainEpoch()
        ? kept.batch
        : null;
    kept = null;
    const batch = ready ?? (await checked(plan));
    const atomic = atomicSend(chainCaps, batch.length);
    if (!atomic) throw new AgentStop(NOT_ATOMIC);
    let id: string;
    try {
      ({ id } = await send.mutateAsync({
        chainId: CHAIN_ID,
        calls: batch.map(({ to, data }) => ({ to, data })),
        ...atomic,
      }));
    } catch (e) {
      if (isPopupBlocked(e)) kept = { key: plan.key, batch, at: Date.now(), epoch: chainEpoch() };
      throw e;
    }
    try {
      const landed = await waitForCallsStatus(config, { id });
      if (landed.status !== "success") throw new AgentStop(REGISTER_FAILED);
      void queryClient.invalidateQueries();
    } finally {
      chainMoved();
      await refetch();
    }
  }

  /**
   * A job's grant on JAW's own sheet (a grant request carries one permission); the change's last batch registers it
   * (`registerJobs`). Protect · sell and the Rebalancer take a limit per stock as well (`stockLimitsRaw`). The request
   * is built here, synchronously from the tap, and JAW's grant is called before anything is awaited (Safari opens JAW's
   * popup only inside the tap's activation). A job already granted on the same terms and only waiting for its
   * registration (a batch that didn't open, one cancelled) opens no sheet, so trying again never grants twice.
   */
  async function grantJob(job: AgentJob, capRaw: bigint, limitsRaw?: StockLimits) {
    if (!executor) throw new Error("Agents aren't available yet");
    ownAccount();
    const waiting = waitingGrant(job);
    if (waiting && waiting.capRaw === capRaw && sameLimits(waiting.limitsRaw, limitsRaw)) return;
    const request = {
      address: account,
      chainId: CHAIN_ID,
      expiry: Math.floor(Date.now() / 1000) + GRANT_SECONDS,
      spender: executor,
      permissions: jobGrant(job, capRaw, limitsRaw),
    };
    const granted = readAgentGrant(listedFromGrant(await grant.mutateAsync(request)), executor);
    if (granted) fresh.set(freshKey(account, job), granted);
    await refetch();
  }

  /**
   * A change's last batch (Adrian, 2026-10-20: "Batch those into one"): its registry `settings` (`setMix`,
   * `setKeepMix`) and the registration of each of `jobs`' grants that the executor doesn't run yet, this page's own
   * first, in one JAW sheet. Nothing to register and no setting: nothing opens.
   */
  async function registerJobs(jobs: readonly AgentJob[], settings: readonly Call[] = []) {
    ownAccount();
    const grants = jobs.map(waitingGrant).filter((g): g is AgentGrant => !!g);
    if (grants.length === 0 && settings.length === 0) return;
    await register(grants, settings);
  }

  /**
   * Revokes every grant JAW lists for the job that hasn't ended, so nothing is left for the executor to use. The first
   * revoke is called straight from the tap; one that stops part way (cancelled, or a sheet JAW couldn't open) leaves
   * the rest for the next try, which skips those already revoked.
   */
  async function turnOff(job: AgentJob) {
    ownAccount();
    // Shown on, but the list can't be read: nothing known to revoke. Say so rather than return as if it were off.
    const toRevoke = live[job].filter((g) => !revoked.has(g.permissionId)).length;
    if (offUnreadable(status[job], toRevoke, listed.isError)) throw new Error(OFF_UNREADABLE);
    fresh.delete(freshKey(account, job));
    stoppedSettings.delete(freshKey(account, job));
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
    /** JAW's list of the account's grants couldn't be read (jobStatus then trusts the registry alone). */
    listUnreadable: listed.isError,
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
    busy: grant.isPending || revoke.isPending || send.isPending,
    error: grant.error ?? revoke.error ?? send.error,
    grantJob,
    registerJobs,
    /** A save that sets `job`'s settings alone: the stopped change's settings are no longer what the user wants. */
    forgetSettings: (job: AgentJob) => stoppedSettings.delete(freshKey(account, job)),
    turnOff,
    refetch,
    /** The jobs JAW granted that the executor hasn't registered yet: they show "starting" and run once registered. */
    toFinish,
    /** The batch that registers them all, for useTx (null when there are none): the Agents tab's Finish card. */
    finishPlan,
  };
}

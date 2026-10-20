"use client";

import { useEffect, useMemo } from "react";
import { isAddressEqual, zeroAddress, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { usePermissions } from "@jaw.id/wagmi";
import { getPermissionFromRelay, type Permission } from "@jaw.id/core";
import type { Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import type { SpendLeft } from "@/lib/agents/next";
import {
  contractPermission,
  jawPermission,
  managerOwnerCalls,
  permissionIdFromReceipt,
  storePermissionInRelay,
} from "@/lib/agents/oneTapGrant";
import {
  GRANT_SECONDS,
  JOBS,
  grantPermission,
  jobGrant,
  readAgentGrant,
  readStockLimits,
  type AgentGrant,
  type AgentJob,
  type JawPermission,
  type StockLimits,
} from "@/lib/agents/permissions";
import { pickFor } from "@/lib/agents/picks";
import { deleteFromRelay, recordInRelay, relayPermission, type RelayDeps } from "@/lib/agents/relay";
import { jobStatus, type AgentStatus, type Stored } from "@/lib/agents/status";
import { PROTOCOLS } from "@/lib/protocols/config";
import { justanAccountAbi, permissionManagerAbi } from "@/lib/protocols/abis";
import { agentChangePlan, registerPlan, type ChangePrefix } from "@/lib/tx/plans";
import { txKey, type TxPlan, type TxReceipt } from "@/lib/tx/prepared";
import { useNowSec } from "@/hooks/useNowSec";

export { GRANT_SECONDS } from "@/lib/agents/permissions";

/** What a job runs with: its limit, and for Protect · sell and the Rebalancer each stock's. */
type JobTerms = { capRaw: bigint; limitsRaw?: StockLimits };

/** A job's new grant in a change: its limit, and each stock's for Protect · sell and the Rebalancer. */
export type GrantStep = { job: AgentJob; capRaw: bigint; limitsRaw?: StockLimits };

/** A grant the account holds, as the manager knows it: its id (the manager's hash) and the struct it approved. */
type Held = { id: Hex; job: AgentJob; p: JawPermission };

const byJob = <T>(f: (job: AgentJob) => T) =>
  Object.fromEntries(JOBS.map((job) => [job, f(job)])) as Record<AgentJob, T>;

const MANAGER = PROTOCOLS.PERMISSION_MANAGER as `0x${string}`;
const API_KEY = process.env.NEXT_PUBLIC_JAW_API_KEY;

/** JAW's relay, as the app reads and writes it (lib/agents/relay.ts). */
const RELAY: RelayDeps = {
  get: (id) => getPermissionFromRelay(id, API_KEY),
  store: (id, p) => storePermissionInRelay(id, p, CHAIN_ID, API_KEY),
};

/**
 * Grants revoked on this page (permission ids), and when: every screen's useAgents shares it, so catch-up never puts a
 * grant back in JAW's list while Base's public node still reads it as live.
 */
const revoked = new Map<string, number>();

/**
 * Grants the app is putting in JAW's relay (permission ids), and when it last tried: one write at a time across
 * screens, and a try that failed waits a minute before the next screen tries again.
 */
const recording = new Map<string, number>();
const RETRY_MS = 60_000;

/**
 * One account's agents. A change is one batch, one Face ID (D14 dropped, Adrian 2026-10-20: "the permission, the cash
 * move and the registration in one signature like Leo's Guardian"): its new grants approved in JAW's manager and
 * registered with GooseExecutor, the grants they replace (or a turn-off's) revoked, with the registry settings and
 * anything that goes first (`changePlan`, signed through useTx). Once it lands the app puts each new grant in JAW's
 * relay as JAW's own grant does, so JAW lists it (`usePermissions`), and takes revoked ones out.
 *
 * Whether a job runs is read on Base: registered in the executor (`jobsOf`, `permissionOf`), not past its end, not
 * revoked in the manager, and the manager still an owner of the account, so a list that's late or a record that
 * didn't save never shows a running agent as off. A listed record counts only when the manager's hash of it is its
 * id and the manager has it approved and not revoked: JAW's relay takes writes from anyone with the app's public key.
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
  const { address: signer } = useAccount();
  const own = !!signer && isAddressEqual(signer, account);
  const nowSec = useNowSec();
  const client = usePublicClient({ chainId: CHAIN_ID });

  /** The registry: the job bits, failures in a row and the back-off, and each job's stored grant (with its stock limits). */
  const stored = useMemo(() => {
    if (!registry.data) return undefined;
    const [[jobs, , , fails, cooldownUntil], ...raw] = registry.data;
    const permissions = raw.map((p) => ({ ...p, calls: [...p.calls], spends: [...p.spends] }) as JawPermission);
    const grants = byJob((job): Stored & { limitsRaw?: StockLimits; salt: bigint } => {
      const p = permissions[JOBS.indexOf(job)];
      const limitsRaw =
        job === "sell" || job === "rebalance" ? (readStockLimits(job, p.spends) ?? undefined) : undefined;
      return { start: p.start, end: p.end, cap: p.spends[0]?.allowance ?? 0n, limitsRaw, salt: p.salt };
    });
    const registered = JOBS.filter((job) => (jobs & (1 << JOBS.indexOf(job))) !== 0);
    return { jobs, fails, cooldownUntil: Number(cooldownUntil), grants, permissions, registered };
  }, [registry.data]);

  /** Records in JAW's list that read as one of our grants, with the struct each stands for (not yet checked on Base). */
  const candidates = useMemo(
    () =>
      executor
        ? (listed.data ?? [])
            .map((p) => readAgentGrant(p, executor))
            .filter((g): g is AgentGrant => !!g)
            .map((g) => ({ g, p: grantPermission(g, account, executor) }))
        : [],
    [executor, listed.data, account],
  );

  /**
   * On Base, in one read: each registered job's id and whether the manager revoked it, whether the manager still owns
   * the account, and for each listed record the manager's hash of its struct and whether it's approved and not revoked.
   */
  const heldJobs = stored?.registered ?? [];
  const reads = [
    ...heldJobs.flatMap((job) => {
      const p = stored!.permissions[JOBS.indexOf(job)];
      return [
        { address: MANAGER, abi: permissionManagerAbi, functionName: "getHash", args: [p], chainId: CHAIN_ID },
        { address: MANAGER, abi: permissionManagerAbi, functionName: "isRevoked", args: [p], chainId: CHAIN_ID },
      ] as const;
    }),
    ...(heldJobs.length > 0
      ? ([
          {
            address: account,
            abi: justanAccountAbi,
            functionName: "isOwnerAddress",
            args: [MANAGER],
            chainId: CHAIN_ID,
          },
        ] as const)
      : []),
    ...candidates.flatMap(
      ({ p }) =>
        [
          { address: MANAGER, abi: permissionManagerAbi, functionName: "getHash", args: [p], chainId: CHAIN_ID },
          { address: MANAGER, abi: permissionManagerAbi, functionName: "isApproved", args: [p], chainId: CHAIN_ID },
          { address: MANAGER, abi: permissionManagerAbi, functionName: "isRevoked", args: [p], chainId: CHAIN_ID },
        ] as const,
    ),
  ];
  const chain = useReadContracts({
    contracts: reads,
    allowFailure: false,
    query: { enabled: !!executor && !!stored && reads.length > 0, refetchInterval: 20_000 },
  });
  const onChain = useMemo(() => {
    if (!stored) return null;
    if (reads.length === 0) return { held: [] as Held[], alive: byJob(() => false), verified: [] as AgentGrant[] };
    if (!chain.data) return null;
    const d = chain.data as readonly unknown[];
    const owns = heldJobs.length > 0 ? (d[2 * heldJobs.length] as boolean) : false;
    const held: Held[] = [];
    const alive = byJob(() => false);
    heldJobs.forEach((job, k) => {
      const isRevoked = d[2 * k + 1] as boolean;
      if (!isRevoked) held.push({ id: d[2 * k] as Hex, job, p: stored.permissions[JOBS.indexOf(job)] });
      alive[job] = !isRevoked && owns;
    });
    const base = 2 * heldJobs.length + (heldJobs.length > 0 ? 1 : 0);
    const verified = candidates
      .filter((_, k) => {
        const [hash, approved, isRevoked] = d.slice(base + 3 * k, base + 3 * k + 3) as [Hex, boolean, boolean];
        return approved && !isRevoked && hash.toLowerCase() === candidates[k].g.permissionId.toLowerCase();
      })
      .map(({ g }) => g);
    return { held, alive, verified };
    // `reads` and heldJobs follow `stored` and `candidates`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.data, stored, candidates]);

  /** Our grants in JAW's list: records whose id is the manager's hash of them, approved and not revoked. */
  const granted = useMemo(() => onChain?.verified ?? [], [onChain]);

  const status = useMemo(
    () =>
      byJob((job): AgentStatus => {
        if (!executor) return "unconfigured";
        if (!stored || listed.isLoading) return "loading";
        // Base couldn't be read for the manager: the registry alone decides, as when the list can't be read.
        const alive = chain.isError && !chain.data ? true : onChain?.alive[job];
        if (alive === undefined) return "loading";
        return jobStatus(job, stored.jobs, stored.grants[job], granted, nowSec, listed.isError, alive);
      }),
    [executor, stored, listed.isLoading, listed.isError, chain.isError, chain.data, onChain, granted, nowSec],
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
        return newest ? { capRaw: newest.capRaw, limitsRaw: newest.limitsRaw, end: newest.end } : null;
      }),
    [status, stored, live],
  );

  /** When a job stopped without being revoked: its grant the executor held ran out (a revoked one never counts). */
  const ranOut = useMemo(
    () =>
      byJob((job): number | null => {
        if (status[job] !== "off" || !stored) return null;
        const held = onChain?.held.find((h) => h.job === job);
        const end = held ? stored.grants[job].end : 0;
        return end > 0 && end < nowSec ? end : null;
      }),
    [status, stored, onChain, nowSec],
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
      address: MANAGER,
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

  const refetch = () => Promise.all([listed.refetch(), registry.refetch(), chain.refetch()]);

  /**
   * Each job's newest grant JAW lists that the executor hasn't registered and that is newer than the one it holds: one
   * granted on JAW's own sheet before grants became one signature, its registration still to go. A grant a newer one
   * replaced is never it.
   */
  const unregistered = useMemo(
    () =>
      byJob((job): AgentGrant | null => {
        const newest = live[job][0];
        if (!newest || !stored) return null;
        const g = stored.grants[job];
        return newest.salt !== g.salt && newest.start > g.start ? newest : null;
      }),
    [live, stored],
  );

  /** The jobs granted on JAW's sheet that the executor doesn't run yet (status "starting"), and the batch that registers them all. */
  const toFinish = JOBS.filter((job) => status[job] === "starting" && unregistered[job]);
  const finishPlan: TxPlan | null =
    executor && toFinish.length > 0
      ? registerPlan(
          account,
          toFinish.map((job) => grantPermission(unregistered[job]!, account, executor)),
        )
      : null;

  /**
   * Every grant of `job` the manager has approved and not revoked, that hasn't ended: the one the executor holds and
   * each JAW lists. What a turn-off takes back, and what a new grant replaces, so nothing old stays approved.
   */
  const liveGrants = (job: AgentJob): Held[] => {
    const out: Held[] = [];
    const held = onChain?.held.find((h) => h.job === job);
    if (held && held.p.end >= nowSec) out.push(held);
    for (const g of live[job]) {
      if (out.some((h) => h.p.salt === g.salt) || !executor) continue;
      out.push({ id: g.permissionId, job, p: grantPermission(g, account, executor) });
    }
    return out.filter((h) => !revoked.has(h.id.toLowerCase()));
  };

  /**
   * Puts grants in JAW's relay (lib/agents/relay.ts): each under its id, once at a time across screens, a failed try
   * left for the next catch-up a minute on, never one revoked on this page, and only while Base still reads it as
   * approved and not revoked. Never sends a batch.
   */
  async function record(entries: readonly { id: Hex; p: Permission }[]) {
    if (!client) return;
    const todo = entries.filter(({ id }) => {
      const key = id.toLowerCase();
      const at = recording.get(key);
      return !revoked.has(key) && (at === undefined || Date.now() - at > RETRY_MS);
    });
    if (todo.length === 0) return;
    for (const { id } of todo) recording.set(id.toLowerCase(), Date.now());
    for (const { id, p } of todo) {
      const struct = contractPermission(p);
      const [approved, isRevoked] = await Promise.all([
        client.readContract({
          address: MANAGER,
          abi: permissionManagerAbi,
          functionName: "isApproved",
          args: [struct],
        }),
        client.readContract({ address: MANAGER, abi: permissionManagerAbi, functionName: "isRevoked", args: [struct] }),
      ]).catch(() => [false, true]);
      if (!approved || isRevoked || revoked.has(id.toLowerCase())) continue;
      // Saved: no more tries this page (the list shows it on its next read). Not saved: the next catch-up tries again.
      if (await recordInRelay(id, p, CHAIN_ID, RELAY)) recording.set(id.toLowerCase(), Number.POSITIVE_INFINITY);
    }
    await listed.refetch();
  }

  /**
   * A change's batch landed: its revoked grants are marked here and taken out of JAW's relay, and each new grant goes in
   * under its id, read off the receipt (the PermissionApproved the manager logged for exactly that struct; a bundle's
   * receipt holds other accounts' logs too), else from the manager's hash.
   */
  function landedFor(grants: readonly Permission[], revokes: readonly Held[]) {
    return async (receipts: readonly TxReceipt[]) => {
      const now = Date.now();
      for (const h of revokes) revoked.set(h.id.toLowerCase(), now);
      void Promise.all(revokes.map((h) => deleteFromRelay(h.id, API_KEY)));
      void registry.refetch();
      if (grants.length === 0 || !client) return void chain.refetch();
      const logs = receipts.flatMap((r) => r.logs ?? []);
      const ids = await Promise.all(
        grants.map(async (p) => {
          try {
            return permissionIdFromReceipt(logs, p);
          } catch {
            return (await client.readContract({
              address: MANAGER,
              abi: permissionManagerAbi,
              functionName: "getHash",
              args: [contractPermission(p)],
            })) as Hex;
          }
        }),
      );
      await record(grants.map((p, k) => ({ id: ids[k], p })));
      void chain.refetch();
    };
  }

  // Catch-up: a grant the executor runs that JAW's list doesn't show (a record that didn't save after its batch, or a
  // screen closed before it landed) is put in the relay from the registry's own copy of it. The signed-in account's
  // own only; never one revoked on this page in the last minute, and `record` reads Base again right before.
  const missing = useMemo(() => {
    if (!own || !stored || !onChain || listed.isLoading || listed.isError) return [];
    const ids = new Set(onChain.verified.map((g) => g.permissionId.toLowerCase()));
    return onChain.held.flatMap((h) => {
      if (h.p.end < nowSec || ids.has(h.id.toLowerCase()) || revoked.has(h.id.toLowerCase())) return [];
      const relay = relayPermission(h.p);
      return relay ? [{ id: h.id, p: relay }] : [];
    });
  }, [own, stored, onChain, listed.isLoading, listed.isError, nowSec]);
  const missingKey = missing.map((m) => m.id).join(",");
  useEffect(() => {
    if (missing.length > 0) void record(missing);
    // `missing` follows its ids; record reads the latest list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  /**
   * A change's one batch, for useTx (null when the agents aren't available or there's nothing to do): `grants` (each
   * job's new grant, its start and salt picked once per terms and per the grant the executor holds, lib/agents/picks.ts),
   * `off` (jobs turned off), the registry `settings`, and `prefix` first (Start earning's supply). Each job granted
   * anew or turned off has every live grant of it revoked in the same batch.
   */
  function changePlan(change: {
    grants?: readonly GrantStep[];
    off?: readonly AgentJob[];
    settings?: readonly Call[];
    prefix?: ChangePrefix;
  }): TxPlan | null {
    if (!executor || !client || !stored || !onChain) return null;
    const asked = change.grants ?? [];
    const jobs = [...new Set([...asked.map((g) => g.job), ...(change.off ?? [])])];
    const revokes = jobs.flatMap(liveGrants);
    if (asked.length === 0 && revokes.length === 0 && (change.settings?.length ?? 0) === 0 && !change.prefix)
      return null;
    const grants = asked.map((g) => {
      const held = stored.grants[g.job];
      const pick = pickFor(account, g.job, txKey(g.capRaw, g.limitsRaw, held.salt, held.start), held.start + 1);
      return jawPermission(account, executor, pick.start + GRANT_SECONDS, jobGrant(g.job, g.capRaw, g.limitsRaw), pick);
    });
    return agentChangePlan(
      account,
      { grants, revokes: revokes.map((h) => h.p), settings: change.settings, prefix: change.prefix },
      { ownerCalls: () => managerOwnerCalls(client, account), landed: landedFor(grants, revokes) },
    );
  }

  return {
    status,
    terms,
    ranOut,
    lastTerms,
    left,
    /** What's left of the running jobs' limits couldn't be read (`left` stays null until it is). */
    leftUnreadable: periods.isError && !periods.data,
    /** Grants a turn-off of `jobs` takes back, all in one batch (0: nothing to turn off). */
    toTurnOff: (jobs: readonly AgentJob[]) => jobs.reduce((n, job) => n + liveGrants(job).length, 0),
    /** The most any limit may be on this executor, once read. */
    capMaxRaw: capMax.data ?? null,
    /** The registry couldn't be read (every status stays "loading" until it is). */
    unreadable: registry.isError && !registry.data,
    /** Failed runs in a row, and when the executor tries again: it backs off, then switches the account off at eight. */
    fails: stored?.fails ?? 0,
    cooldownUntil: stored?.cooldownUntil ?? 0,
    changePlan,
    refetch,
    /** The jobs granted on JAW's sheet that the executor hasn't registered yet: they show "starting" and run once registered. */
    toFinish,
    /** The batch that registers them all, for useTx (null when there are none). */
    finishPlan,
  };
}

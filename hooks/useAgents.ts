"use client";

import { useEffect, useMemo, useRef } from "react";
import { isAddressEqual, zeroAddress, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { usePermissions } from "@jaw.id/wagmi";
import { getPermissionFromRelay, type Permission } from "@jaw.id/core";
import type { Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { executorAccountsAbi } from "@/lib/agents/abis/accounts";
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
  carriesTopUps,
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
import { encodePermission, REGISTER_FALLBACK } from "@/lib/agents/register";
import { buildSetTopUpsCalls } from "@/lib/agents/settings";
import { deleteFromRelay, recordInRelay, relayPermission, type RelayDeps } from "@/lib/agents/relay";
import { jobStatus, type AgentStatus, type Stored } from "@/lib/agents/status";
import { PROTOCOLS } from "@/lib/protocols/config";
import { justanAccountAbi, permissionManagerAbi } from "@/lib/protocols/abis";
import { agentChangePlan, registerPlan, type ChangePrefix } from "@/lib/tx/plans";
import { TxStop, txKey, type TxPlan, type TxReceipt } from "@/lib/tx/prepared";
import { useNowSec } from "@/hooks/useNowSec";
import { useTopUpsSwitch } from "@/hooks/useTopUps";

export { GRANT_SECONDS } from "@/lib/agents/permissions";

/**
 * What a job runs with: its limit, for Protect · sell and the Rebalancer each stock's, and whether the Rebalancer's
 * grant carries top-ups (the savings withdraw).
 */
type JobTerms = { capRaw: bigint; limitsRaw?: StockLimits; topUps?: boolean };

/**
 * A job's new grant in a change: its limit, each stock's for Protect · sell and the Rebalancer, and for the Rebalancer
 * whether it carries top-ups.
 */
export type GrantStep = { job: AgentJob; capRaw: bigint; limitsRaw?: StockLimits; topUps?: boolean };

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

/** What the manager says of one struct: its id (the manager's hash) and whether it's approved and revoked. */
type ManagerRead = { id: Hex; approved: boolean; revoked: boolean };

/**
 * The manager's answers by struct, for every screen: a new read for the same grants (a new list, the registry after a
 * change) never sends a screen back to loading. A change this page landed is written in at once, and a read that says
 * otherwise in the next half minute is taken as Base's public node not there yet.
 */
const managerCache = new Map<string, ManagerRead & { seededAt?: number }>();
const owners = new Map<string, boolean>();
const SEEDED_MS = 30_000;
/** How long after a landed change the registry is read once more, for a public node a block behind JAW's. */
const REREAD_MS = 3_000;
const cacheKey = (p: JawPermission) => encodePermission(p).toLowerCase();
function readManager(p: JawPermission, r: ManagerRead) {
  const key = cacheKey(p);
  const had = managerCache.get(key);
  const differs = had && (had.approved !== r.approved || had.revoked !== r.revoked);
  if (had?.seededAt && differs && Date.now() - had.seededAt < SEEDED_MS) return;
  managerCache.set(key, r);
}

/**
 * Grants this page just landed (salts), and when: never shown as waiting for a Finish while Base's public node is
 * still a block behind (the registry read again catches up within seconds).
 */
const justLanded = new Map<string, number>();
const LANDED_MS = 60_000;
const landedRecently = (salt: bigint) => {
  const at = justLanded.get(salt.toString());
  return at !== undefined && Date.now() - at < LANDED_MS;
};

/** Said when Base can't be read for the manager: nothing is built on a guess. */
const CANT_CHECK_AGENTS = "We couldn’t check your agents with Base right now. Nothing changed. Try again.";
/** Said when JAW's list can't be read: a grant only it knows of could be left behind, so nothing changes. */
const LIST_UNREADABLE = "We couldn’t check what’s switched on right now, so nothing changed. Try again.";

/** A change that can't go ahead now, said at the button (useTx shows a TxStop's words and waits). */
const stopPlan = (account: `0x${string}`, why: string): TxPlan => ({
  key: txKey("agents-stop", account, why),
  user: account,
  calls: () => Promise.reject(new TxStop(why)),
});

/**
 * One account's agents. A change is one batch, one Face ID (D14 dropped, Adrian 2026-10-20: "the permission, the cash
 * move and the registration in one signature like Leo's Guardian"): its new grants approved in JAW's manager and
 * registered with GooseExecutor, the grants they replace (or a turn-off's) revoked, with the registry settings and
 * anything that goes first (`changePlan`, signed through useTx). Once it lands the app puts each new grant in JAW's
 * relay as JAW's own grant does, so JAW lists it (`usePermissions`), and takes revoked ones out.
 *
 * Whether a job runs is read on Base: registered in the executor (`accounts`, `permissionOf`), not past its end, not
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
      // `accounts`, not `jobsOf`: the top-ups executor drops jobsOf to fit 24 KB. Read with the fields both have.
      { address: at, abi: executorAccountsAbi, functionName: "accounts", args: [account], chainId: CHAIN_ID },
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
  // The account's own top-ups switch: a Rebalance turn-off switches it off in the same batch.
  const topUpsSwitch = useTopUpsSwitch(account);

  /** The registry: the job bits, failures in a row and the back-off, and each job's stored grant (with its stock limits). */
  const stored = useMemo(() => {
    if (!registry.data) return undefined;
    const [[jobs, , fails, cooldownUntil], ...raw] = registry.data;
    const permissions = raw.map((p) => ({ ...p, calls: [...p.calls], spends: [...p.spends] }) as JawPermission);
    const grants = byJob((job): Stored & { limitsRaw?: StockLimits; topUps: boolean; salt: bigint } => {
      const p = permissions[JOBS.indexOf(job)];
      const limitsRaw =
        job === "sell" || job === "rebalance" ? (readStockLimits(job, p.spends) ?? undefined) : undefined;
      const topUps = job === "rebalance" && carriesTopUps(p.spends);
      return { start: p.start, end: p.end, cap: p.spends[0]?.allowance ?? 0n, limitsRaw, topUps, salt: p.salt };
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
   * The jobs whose grant the executor keeps (`permissionOf`): registered, or switched off by the executor with its grant
   * kept until it ends. Read on Base whatever the job's bit says: a grant the executor switched off can still be
   * approved, and anyone could register it again, so a turn-off or a new grant revokes it too.
   */
  const minute = Math.floor(nowSec / 60);
  const kept = useMemo(
    () =>
      stored
        ? JOBS.filter((job) => {
            const g = stored.grants[job];
            return g.end > 0 && (stored.registered.includes(job) || g.end >= minute * 60);
          })
        : [],
    [stored, minute],
  );
  const keptPermission = (job: AgentJob) => stored!.permissions[JOBS.indexOf(job)];
  const managerReads = (p: JawPermission) =>
    [
      { address: MANAGER, abi: permissionManagerAbi, functionName: "getHash", args: [p], chainId: CHAIN_ID },
      { address: MANAGER, abi: permissionManagerAbi, functionName: "isApproved", args: [p], chainId: CHAIN_ID },
      { address: MANAGER, abi: permissionManagerAbi, functionName: "isRevoked", args: [p], chainId: CHAIN_ID },
    ] as const;
  // On Base: each kept grant's id, whether the manager has it approved and not revoked, and whether the manager still
  // owns the account; then, apart (one record that can't be read never blocks the rest), each listed record's.
  const keptContracts = [
    ...kept.flatMap((job) => managerReads(keptPermission(job))),
    ...(kept.length > 0
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
  ];
  const keptRead = useReadContracts({
    contracts: keptContracts,
    allowFailure: false,
    query: { enabled: !!executor && kept.length > 0, refetchInterval: 20_000 },
  });
  const listRead = useReadContracts({
    contracts: candidates.flatMap(({ p }) => managerReads(p)),
    allowFailure: true,
    query: { enabled: !!executor && candidates.length > 0, refetchInterval: 20_000 },
  });

  /**
   * What Base says, from the reads above through the page's cache of them (so a new read for the same grants never
   * sends a screen back to loading, and a change this page just landed reads as landed at once): the grants the manager
   * has approved and not revoked (`held`), whether each job runs (`alive`), the listed records that are ours
   * (`verified`), and why a change can't be built now (`error`).
   */
  const onChain = useMemo(() => {
    if (!stored) return null;
    if (keptRead.data) {
      const d = keptRead.data as readonly unknown[];
      kept.forEach((job, k) =>
        readManager(keptPermission(job), { id: d[3 * k] as Hex, approved: !!d[3 * k + 1], revoked: !!d[3 * k + 2] }),
      );
      if (kept.length > 0) owners.set(account.toLowerCase(), !!d[3 * kept.length]);
    }
    if (listRead.data) {
      candidates.forEach(({ p }, k) => {
        const r = listRead.data!.slice(3 * k, 3 * k + 3);
        if (r.length === 3 && r.every((x) => x.status === "success"))
          readManager(p, { id: r[0].result as Hex, approved: !!r[1].result, revoked: !!r[2].result });
      });
    }
    const keptInfo = kept.map((job) => managerCache.get(cacheKey(keptPermission(job))));
    const owns = kept.length > 0 ? owners.get(account.toLowerCase()) : true;
    const keptKnown = keptInfo.every(Boolean) && owns !== undefined;
    if (!keptKnown && !keptRead.isError) return null;
    const listKnown = candidates.every(({ p }) => managerCache.has(cacheKey(p))) || !!listRead.data;
    if (!listKnown && !listRead.isError) return null;

    const held: Held[] = [];
    const alive = byJob((job) => (keptKnown ? false : stored.registered.includes(job)));
    kept.forEach((job, k) => {
      const info = keptInfo[k];
      if (!info) return;
      if (info.approved && !info.revoked) held.push({ id: info.id, job, p: keptPermission(job) });
      alive[job] = stored.registered.includes(job) && !info.revoked && owns === true;
    });
    const verified = candidates
      .filter(({ g, p }) => {
        const info = managerCache.get(cacheKey(p));
        return !!info && info.approved && !info.revoked && info.id.toLowerCase() === g.permissionId.toLowerCase();
      })
      .map(({ g }) => g);
    const error = !keptKnown ? CANT_CHECK_AGENTS : !listKnown || listed.isError ? LIST_UNREADABLE : null;
    return { held, alive, verified, error };
    // keptPermission follows `stored`; the caches follow the reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stored,
    kept,
    candidates,
    keptRead.data,
    keptRead.isError,
    listRead.data,
    listRead.isError,
    listed.isError,
    account,
  ]);

  /** Our grants in JAW's list: records whose id is the manager's hash of them, approved and not revoked. */
  const granted = useMemo(() => onChain?.verified ?? [], [onChain]);

  const status = useMemo(
    () =>
      byJob((job): AgentStatus => {
        if (!executor) return "unconfigured";
        if (!stored || listed.isLoading || !onChain) return "loading";
        // Base couldn't be read for the manager: the registry alone decides (`alive` follows the job's bit).
        return jobStatus(job, stored.jobs, stored.grants[job], granted, nowSec, listed.isError, onChain.alive[job]);
      }),
    [executor, stored, listed.isLoading, listed.isError, onChain, granted, nowSec],
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
          return { capRaw: g.cap, limitsRaw: g.limitsRaw, topUps: g.topUps, end: g.end };
        }
        if (status[job] !== "starting") return null;
        const newest = live[job][0];
        return newest
          ? { capRaw: newest.capRaw, limitsRaw: newest.limitsRaw, topUps: !!newest.topUps, end: newest.end }
          : null;
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
        if (newest) return { capRaw: newest.capRaw, limitsRaw: newest.limitsRaw, topUps: !!newest.topUps };
        const g = stored?.grants[job];
        return g && g.cap > 0n ? { capRaw: g.cap, limitsRaw: g.limitsRaw, topUps: g.topUps } : null;
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

  const refetch = () => Promise.all([listed.refetch(), registry.refetch(), keptRead.refetch(), listRead.refetch()]);

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
        return newest.salt !== g.salt && newest.start > g.start && !landedRecently(newest.salt) ? newest : null;
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
   * Every grant of `job` the manager has approved and not revoked, that hasn't ended: the one the executor keeps (its
   * bit set or not) and each JAW lists. What a turn-off takes back, and what a new grant replaces, so nothing old stays
   * approved for anyone to register.
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
      for (const h of revokes) {
        revoked.set(h.id.toLowerCase(), now);
        managerCache.set(cacheKey(h.p), { id: h.id, approved: true, revoked: true, seededAt: now });
      }
      void Promise.all(revokes.map((h) => deleteFromRelay(h.id, API_KEY)));
      // The registry again now, and once more a few seconds on: Base's public node can be a block behind JAW's.
      void registry.refetch();
      setTimeout(() => void registry.refetch(), REREAD_MS);
      if (grants.length === 0 || !client) return;
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
      grants.forEach((p, k) => {
        managerCache.set(cacheKey(contractPermission(p)), {
          id: ids[k],
          approved: true,
          revoked: false,
          seededAt: now,
        });
        justLanded.set(p.salt.toString(), now);
      });
      await record(grants.map((p, k) => ({ id: ids[k], p })));
    };
  }

  // Catch-up: a grant the executor runs that JAW's list doesn't show (a record that didn't save after its batch, or a
  // screen closed before it landed) is put in the relay from the registry's own copy of it. The signed-in account's
  // own only; never one revoked on this page in the last minute, and `record` reads Base again right before.
  const missing = useMemo(() => {
    if (!own || !stored || !onChain || listed.isLoading || listed.isError) return [];
    const ids = new Set(onChain.verified.map((g) => g.permissionId.toLowerCase()));
    return onChain.held.flatMap((h) => {
      if (!stored.registered.includes(h.job) || h.p.end < nowSec) return [];
      if (ids.has(h.id.toLowerCase()) || revoked.has(h.id.toLowerCase())) return [];
      const relay = relayPermission(h.p);
      return relay ? [{ id: h.id, p: relay }] : [];
    });
  }, [own, stored, onChain, listed.isLoading, listed.isError, nowSec]);
  const missingKey = missing.map((m) => m.id).join(",");
  const latestMissing = useRef(missing);
  useEffect(() => {
    latestMissing.current = missing;
  });
  // At once, then a minute on while any is still missing (a try Base's public node wasn't ready for, or the relay
  // refused, is tried again; `record` keeps one write at a time across screens).
  useEffect(() => {
    if (!missingKey) return;
    void record(latestMissing.current);
    const again = setInterval(() => void record(latestMissing.current), RETRY_MS + 1_000);
    return () => clearInterval(again);
    // record reads the latest list and client; `missing` follows its ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  /**
   * A change's one batch, for useTx: `grants` (each job's new grant, its start and salt picked once per terms and per
   * the grant the executor holds, lib/agents/picks.ts), `off` (jobs turned off), the registry `settings`, and `prefix`
   * first (Start earning's supply). Each job granted anew or turned off has every live grant of it revoked in the same
   * batch, and turning Rebalance off while top-ups are on switches them off too (`setTopUps(false)`), so nothing is
   * left counting for a Rebalancer that's gone. Null while the agents' reads load (the screens wait on "loading") or
   * with nothing to do; a plan that says why at the button when Base or JAW's list can't be read, or the grant can't
   * be built.
   */
  function changePlan(change: {
    grants?: readonly GrantStep[];
    off?: readonly AgentJob[];
    settings?: readonly Call[];
    prefix?: ChangePrefix;
  }): TxPlan | null {
    if (!executor || !client || !stored || !onChain) return null;
    // Rebalance's turn-off switches top-ups off too, so it waits for the switch's first read.
    if (change.off?.includes("rebalance") && topUpsSwitch === undefined) return null;
    const asked = change.grants ?? [];
    const jobs = [...new Set([...asked.map((g) => g.job), ...(change.off ?? [])])];
    // Nothing is granted or revoked on a guess: what Base or JAW's list would have said could be left behind.
    if (jobs.length > 0 && onChain.error) return stopPlan(account, onChain.error);
    const revokes = jobs.flatMap(liveGrants);
    if (asked.length === 0 && revokes.length === 0 && (change.settings?.length ?? 0) === 0 && !change.prefix)
      return null;
    let grants: Permission[];
    let settings = change.settings ?? [];
    try {
      grants = asked.map((g) => {
        const held = stored.grants[g.job];
        const terms = txKey(g.capRaw, g.limitsRaw, !!g.topUps, held.salt, held.start);
        const pick = pickFor(account, g.job, terms, held.start + 1);
        const detail = jobGrant(g.job, g.capRaw, g.limitsRaw, g.topUps);
        return jawPermission(account, executor, pick.start + GRANT_SECONDS, detail, pick);
      });
      if (change.off?.includes("rebalance") && topUpsSwitch?.on)
        settings = [...settings, ...buildSetTopUpsCalls(account, false, topUpsSwitch.keepRaw)];
    } catch {
      // A grant its job's template can't hold (a Rebalancer with no stock it may sell): said, never thrown in render.
      return stopPlan(account, REGISTER_FALLBACK);
    }
    return agentChangePlan(
      account,
      { grants, revokes: revokes.map((h) => h.p), settings, prefix: change.prefix },
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

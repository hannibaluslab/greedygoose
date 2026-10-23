"use client";

import { useEffect, useMemo, useRef } from "react";
import { isAddressEqual, zeroAddress, type Hex } from "viem";
import { useAccount, useBlock, usePublicClient, useReadContracts } from "wagmi";
import { usePermissions } from "@jaw.id/wagmi";
import { getPermissionFromRelay, type Permission } from "@jaw.id/core";
import type { Call } from "@/lib/aave/tx";
import { CHAIN_ID } from "@/lib/chain";
import { GOOSE_GUARD } from "@/lib/agents/config";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
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
import {
  LEGACY_EXECUTOR,
  LEGACY_JOB_IDS,
  legacyCandidates,
  legacyExecutorAbi,
  legacyRevokesFor,
  legacyToRevoke,
} from "@/lib/agents/legacy";
import { pickFor } from "@/lib/agents/picks";
import {
  buildUnregisterCalls,
  decodePermission,
  encodePermission,
  heldStartOf,
  REGISTER_FALLBACK,
} from "@/lib/agents/register";
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

/** What a job runs with: for Protect · sell and the Rebalancer, the stocks it may sell. No job has an amount limit. */
type JobTerms = { limitsRaw?: StockLimits };

/** A job's new grant in a change: for Protect · sell and the Rebalancer, the stocks it may sell. */
export type GrantStep = { job: AgentJob; limitsRaw?: StockLimits };

/** A job's grant GooseGuard holds none of: what `permissionOf` reads as before the job's first grant. */
const NONE: JawPermission = {
  account: zeroAddress,
  spender: zeroAddress,
  start: 0,
  end: 0,
  salt: 0n,
  calls: [],
  spends: [],
};

/** A grant the account holds, as the manager knows it: its id (the manager's hash) and the struct it approved. */
type Held = { id: Hex; job: AgentJob; p: JawPermission };
/** A grant a change revokes: one of the Guard's (`Held`) or one to main's GooseExecutor (GG-05, lib/agents/legacy.ts). */
type Revoke = { id: Hex; p: JawPermission };

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

type TopUpsSwitch = ReturnType<typeof useTopUpsSwitch>;

/**
 * Rebalance's turn-off switches top-ups off too: it waits (null) while the switch is first read, and says why when Base
 * doesn't answer rather than wait for ever. Undefined when it may go ahead.
 */
const topUpsOffGate = (
  account: `0x${string}`,
  off: readonly AgentJob[] | undefined,
  topUps: TopUpsSwitch,
): TxPlan | null | undefined => {
  if (!off?.includes("rebalance")) return undefined;
  if (topUps === undefined) return null;
  return topUps === "unreadable" ? stopPlan(account, CANT_CHECK_AGENTS) : undefined;
};

/**
 * `setTopUps(false)` when Rebalance turns off with top-ups on: with no Rebalancer, the cash top-ups leave in the wallet
 * would wait for ever instead of going back to earning.
 */
const topUpsOffCalls = (account: `0x${string}`, off: readonly AgentJob[] | undefined, topUps: TopUpsSwitch): Call[] =>
  off?.includes("rebalance") && typeof topUps === "object" && topUps?.on
    ? buildSetTopUpsCalls(account, false, topUps.keepRaw)
    : [];

/**
 * One account's agents. A change is one batch, one Face ID (D14 dropped, Adrian 2026-10-20: "the permission, the cash
 * move and the registration in one signature like Leo's Guardian"): its new grants approved in JAW's manager and
 * registered with GooseGuard, the grants they replace (or a turn-off's) revoked and the job unregistered, with the
 * Guard settings and anything that goes first (`changePlan`, signed through useTx). Once it lands the app puts each new
 * grant in JAW's relay as JAW's own grant does, so JAW lists it (`usePermissions`), and takes revoked ones out.
 *
 * Whether a job runs is read on Base: registered in the Guard (`accountOf`'s job bits, `permissionOf`), not past its
 * end, not revoked in the manager, and the manager still an owner of the account, so a list that's late or a record
 * that didn't save never shows a running agent as off. A listed record counts only when the manager's hash of it is
 * its id and the manager has it approved and not revoked: JAW's relay takes writes from anyone with the app's public key.
 */
export function useAgents(account: `0x${string}`) {
  const guard = GOOSE_GUARD;
  const listed = usePermissions({ address: account, chainId: CHAIN_ID, query: { enabled: !!guard } });
  const at = guard ?? zeroAddress; // the reads stay off until the Guard is configured
  const permissionOf = (id: number) =>
    ({ address: at, abi: guardAbi, functionName: "permissionOf", args: [account, id], chainId: CHAIN_ID }) as const;
  const registry = useReadContracts({
    contracts: [
      { address: at, abi: guardAbi, functionName: "accountOf", args: [account], chainId: CHAIN_ID },
      permissionOf(0),
      permissionOf(1),
      permissionOf(2),
      permissionOf(3),
      permissionOf(4),
    ],
    allowFailure: false,
    query: { enabled: !!guard, refetchInterval: 20_000 },
  });
  // Base's latest block: a new grant starts behind it as well as behind the device's clock (lib/agents/picks.ts).
  const head = useBlock({ chainId: CHAIN_ID, query: { enabled: !!guard, refetchInterval: 20_000 } });
  const headSec = head.data ? Number(head.data.timestamp) : null;
  const { address: signer } = useAccount();
  const own = !!signer && isAddressEqual(signer, account);
  const nowSec = useNowSec();
  const client = usePublicClient({ chainId: CHAIN_ID });
  // The account's own top-ups switch: a Rebalance turn-off switches it off in the same batch.
  const topUpsSwitch = useTopUpsSwitch(account);

  /**
   * What the Guard holds: the job bits, and each job's newest grant (`permissionOf`, kept after `unregister`) with the
   * stocks it may sell and its start, the high-water mark a new grant must pass. A job's bytes the app can't read as a
   * permission (the account registered something else itself) read as none, with their start kept.
   */
  const stored = useMemo(() => {
    if (!registry.data) return undefined;
    const [[a], ...raw] = registry.data;
    const permissions = raw.map((bytes): JawPermission => {
      try {
        return bytes === "0x" ? NONE : decodePermission(bytes);
      } catch {
        return { ...NONE, start: heldStartOf(bytes) };
      }
    });
    const grants = byJob((job): Stored & { limitsRaw?: StockLimits; salt: bigint } => {
      const p = permissions[JOBS.indexOf(job)];
      const limitsRaw =
        job === "sell" || job === "rebalance" ? (readStockLimits(job, p.spends) ?? undefined) : undefined;
      return { start: heldStartOf(raw[JOBS.indexOf(job)]), end: p.end, limitsRaw, salt: p.salt };
    });
    const registered = JOBS.filter((job) => (a.jobs & (1 << JOBS.indexOf(job))) !== 0);
    return { jobs: a.jobs, grants, permissions, registered };
  }, [registry.data]);

  /** Records in JAW's list that read as one of our grants, with the struct each stands for (not yet checked on Base). */
  const candidates = useMemo(
    () =>
      guard
        ? (listed.data ?? [])
            .map((p) => readAgentGrant(p, guard))
            .filter((g): g is AgentGrant => !!g)
            .map((g) => ({ g, p: grantPermission(g, account, guard) }))
        : [],
    [guard, listed.data, account],
  );

  /**
   * The jobs whose grant the Guard keeps (`permissionOf`): registered, or unregistered with its grant kept until it
   * ends. Read on Base whatever the job's bit says: a grant switched off can still be approved, and the account could
   * register it again, so a turn-off or a new grant revokes it too.
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
    query: { enabled: !!guard && kept.length > 0, refetchInterval: 20_000 },
  });
  const listRead = useReadContracts({
    contracts: candidates.flatMap(({ p }) => managerReads(p)),
    allowFailure: true,
    query: { enabled: !!guard && candidates.length > 0, refetchInterval: 20_000 },
  });

  // GG-05: the grants main's GooseExecutor still holds for the account (`permissionOf`, one per job) and those JAW lists
  // to it, then each one's id and status in the manager: every one still approved goes in the next change's batch.
  const legacyRegistry = useReadContracts({
    contracts: LEGACY_JOB_IDS.map(
      (id) =>
        ({
          address: LEGACY_EXECUTOR,
          abi: legacyExecutorAbi,
          functionName: "permissionOf",
          args: [account, id],
          chainId: CHAIN_ID,
        }) as const,
    ),
    allowFailure: false,
    query: { enabled: !!guard, refetchInterval: 60_000 },
  });
  const legacyFound = useMemo(
    () =>
      // JAW's list is read first: an old grant only it knows of is never missed.
      legacyRegistry.data && !listed.isLoading
        ? legacyCandidates(
            account,
            listed.data ?? [],
            legacyRegistry.data.map((p) => ({ ...p, calls: [...p.calls], spends: [...p.spends] })),
            minute * 60,
          )
        : null,
    [account, listed.data, listed.isLoading, legacyRegistry.data, minute],
  );
  const legacyRead = useReadContracts({
    contracts: (legacyFound ?? []).flatMap(({ p }) => managerReads(p)),
    allowFailure: true,
    query: { enabled: !!guard && !!legacyFound && legacyFound.length > 0, refetchInterval: 20_000 },
  });

  /**
   * The grants to GooseExecutor the manager has approved and not revoked (`revokes`), through the page's cache like the
   * Guard's own; `known` once Base has answered for all of them (a record JAW lists that Base can't read is left out,
   * as with the Guard's). Never one revoked on this page.
   */
  const legacy = useMemo(() => {
    if (!legacyFound) return { known: false, revokes: [] as Revoke[] };
    if (legacyRead.data) {
      legacyFound.forEach(({ p }, k) => {
        const r = legacyRead.data!.slice(3 * k, 3 * k + 3);
        if (r.length === 3 && r.every((x) => x.status === "success"))
          readManager(p, { id: r[0].result as Hex, approved: !!r[1].result, revoked: !!r[2].result });
      });
    }
    const reads = legacyFound.map(({ p }) => managerCache.get(cacheKey(p)));
    const known = reads.every(Boolean) || !!legacyRead.data;
    const revokes = legacyToRevoke(legacyFound, reads).filter((h) => !revoked.has(h.id.toLowerCase()));
    return { known, revokes };
  }, [legacyFound, legacyRead.data]);
  const legacyUnreadable = (legacyRegistry.isError && !legacyRegistry.data) || (legacyRead.isError && !legacy.known);

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
        if (!guard) return "unconfigured";
        if (!stored || listed.isLoading || !onChain) return "loading";
        // Base couldn't be read for the manager: the registry alone decides (`alive` follows the job's bit).
        return jobStatus(job, stored.jobs, stored.grants[job], granted, nowSec, listed.isError, onChain.alive[job]);
      }),
    [guard, stored, listed.isLoading, listed.isError, onChain, granted, nowSec],
  );

  /** Each job's grants JAW lists that haven't ended, newest first. */
  const live = useMemo(
    () => byJob((job) => granted.filter((g) => g.job === job && g.end >= nowSec).sort((a, b) => b.start - a.start)),
    [granted, nowSec],
  );

  /** What each job runs with: the Guard's grant once it's on, the newest one JAW lists while it's starting. */
  const terms = useMemo(
    () =>
      byJob((job): (JobTerms & { end: number }) | null => {
        if (status[job] === "on" && stored) {
          const g = stored.grants[job];
          return { limitsRaw: g.limitsRaw, end: g.end };
        }
        if (status[job] !== "starting") return null;
        const newest = live[job][0];
        return newest ? { limitsRaw: newest.limitsRaw, end: newest.end } : null;
      }),
    [status, stored, live],
  );

  /** When a job stopped without being revoked: its grant the Guard held ran out (a revoked one never counts). */
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
   * The terms a job last ran with, to renew it: its newest grant in JAW's list, else the Guard's; null if it never had
   * one.
   */
  const lastTerms = useMemo(
    () =>
      byJob((job): JobTerms | null => {
        const newest = granted.filter((g) => g.job === job).sort((a, b) => b.start - a.start)[0];
        if (newest) return { limitsRaw: newest.limitsRaw };
        const g = stored?.grants[job];
        return g && g.end > 0 ? { limitsRaw: g.limitsRaw } : null;
      }),
    [granted, stored],
  );

  const refetch = () =>
    Promise.all([
      listed.refetch(),
      registry.refetch(),
      keptRead.refetch(),
      listRead.refetch(),
      legacyRegistry.refetch(),
      legacyRead.refetch(),
    ]);

  /**
   * Each job's newest grant JAW lists that the Guard hasn't registered and that is newer than the one it holds: one
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

  /** The jobs granted on JAW's sheet that the Guard doesn't run yet (status "starting"), and the batch that registers them all. */
  const toFinish = JOBS.filter((job) => status[job] === "starting" && unregistered[job]);
  const finishPlan: TxPlan | null =
    guard && toFinish.length > 0
      ? registerPlan(
          account,
          toFinish.map((job) => ({ job, p: grantPermission(unregistered[job]!, account, guard) })),
        )
      : null;

  /**
   * Every grant of `job` the manager has approved and not revoked, that hasn't ended: the one the Guard keeps (its bit
   * set or not) and each JAW lists. What a turn-off takes back, and what a new grant replaces, so nothing old stays
   * approved for the account to register again.
   */
  const liveGrants = (job: AgentJob): Held[] => {
    const out: Held[] = [];
    const held = onChain?.held.find((h) => h.job === job);
    if (held && held.p.end >= nowSec) out.push(held);
    for (const g of live[job]) {
      if (out.some((h) => h.p.salt === g.salt) || !guard) continue;
      out.push({ id: g.permissionId, job, p: grantPermission(g, account, guard) });
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
  function landedFor(grants: readonly Permission[], revokes: readonly Revoke[]) {
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

  // Catch-up: a grant the Guard runs that JAW's list doesn't show (a record that didn't save after its batch, or a
  // screen closed before it landed) is put in the relay from the Guard's own copy of it. The signed-in account's
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
   * the grant the Guard holds, lib/agents/picks.ts), `off` (jobs turned off), the Guard `settings`, and `prefix` first
   * (Start earning's supply). Each job granted anew or turned off has every live grant of it revoked in the same batch,
   * a job turned off is unregistered in the Guard too (`unregister`, so it stops at once), and turning Rebalance off
   * while top-ups are on switches them off (`setTopUps(false)`), so no cash is left waiting for a Rebalancer that's gone.
   * Null while the agents' reads load (the screens wait on "loading") or with nothing to do; a plan that says why at
   * the button when Base or JAW's list can't be read, or the grant can't be built.
   */
  function changePlan(change: {
    grants?: readonly GrantStep[];
    off?: readonly AgentJob[];
    settings?: readonly Call[];
    prefix?: ChangePrefix;
  }): TxPlan | null {
    if (!guard || !client || !stored || !onChain || headSec === null) return null;
    const gate = topUpsOffGate(account, change.off, topUpsSwitch);
    if (gate !== undefined) return gate;
    const asked = change.grants ?? [];
    const jobs = [...new Set([...asked.map((g) => g.job), ...(change.off ?? [])])];
    // Nothing is granted or revoked on a guess: what Base or JAW's list would have said could be left behind.
    if (jobs.length > 0 && onChain.error) return stopPlan(account, onChain.error);
    // GG-05: every grant to main's GooseExecutor still approved goes too; a new grant waits until Base has said which.
    const old = legacyRevokesFor(
      { ...legacy, unreadable: legacyUnreadable },
      { granting: asked.length > 0, changingJobs: jobs.length > 0 },
    );
    if (old === "wait") return null;
    if (old === "unreadable") return stopPlan(account, CANT_CHECK_AGENTS);
    const revokes: Revoke[] = [...jobs.flatMap(liveGrants), ...old];
    // A job turned off stops in the Guard at once, its grant revoked or not (one registered and since revoked included).
    const unregisters = (change.off ?? []).filter((job) => stored.registered.includes(job));
    if (
      asked.length === 0 &&
      revokes.length === 0 &&
      unregisters.length === 0 &&
      (change.settings?.length ?? 0) === 0 &&
      !change.prefix
    )
      return null;
    let grants: Permission[];
    let settings = change.settings ?? [];
    try {
      grants = asked.map((g) => {
        const held = stored.grants[g.job];
        const terms = txKey(g.limitsRaw, held.salt, held.start);
        const pick = pickFor(account, g.job, terms, held.start + 1, headSec);
        const detail = jobGrant(g.job, g.limitsRaw);
        return jawPermission(account, guard, pick.start + GRANT_SECONDS, detail, pick);
      });
      settings = [
        ...settings,
        ...topUpsOffCalls(account, change.off, topUpsSwitch),
        ...buildUnregisterCalls(account, unregisters),
      ];
    } catch {
      // A grant its job's template can't hold (a Rebalancer with no stock it may sell): said, never thrown in render.
      return stopPlan(account, REGISTER_FALLBACK);
    }
    return agentChangePlan(
      account,
      { grants, revokes: revokes.map((h) => h.p), settings, prefix: change.prefix },
      {
        getCode: (a) => client.getCode({ address: a }),
        ownerCalls: () => managerOwnerCalls(client, account),
        landed: landedFor(grants, revokes),
      },
    );
  }

  return {
    status,
    terms,
    ranOut,
    lastTerms,
    /** Grants a turn-off of `jobs` takes back, all in one batch (0: nothing to turn off). */
    toTurnOff: (jobs: readonly AgentJob[]) => jobs.reduce((n, job) => n + liveGrants(job).length, 0),
    /** The Guard couldn't be read (every status stays "loading" until it is). */
    unreadable: registry.isError && !registry.data,
    changePlan,
    refetch,
    /** The jobs granted on JAW's sheet that the Guard hasn't registered yet: they show "starting" and run once registered. */
    toFinish,
    /** The batch that registers them all, for useTx (null when there are none). */
    finishPlan,
  };
}

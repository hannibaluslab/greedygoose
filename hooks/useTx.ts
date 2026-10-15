"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, useCapabilities, usePublicClient, useSendCalls, useWaitForCallsStatus } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { ChainCapabilities } from "@jaw.id/core";
import { CHAIN_ID } from "@/lib/chain";
import { explainRevert } from "@/lib/aave/errors";
import { atomicSend } from "@/lib/jaw/capabilities";
import { addLocal, updateLocal } from "@/lib/activity/local";
import { withBoardJoin } from "@/lib/board/join";
import {
  PREPARE_SETTLE_MS,
  PreparedTx,
  TAP_AGAIN,
  checkPlan,
  checkingView,
  idleView,
  signPlan,
  type CheckDeps,
  type PrepView,
  type TxPhase,
  type TxPlan,
} from "@/lib/tx/prepared";

export { TAP_AGAIN, TxStop, txKey } from "@/lib/tx/prepared";
export type { TxPhase, TxPlan } from "@/lib/tx/prepared";

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/** How a batch is checked, at the tap and in the background alike: join() when due, then eth_simulateV1 from the user. */
const checkDeps = (client: Client | undefined): CheckDeps => ({
  join: (user, batch) => withBoardJoin(client!, user, batch),
  simulate: async (user, batch) => (await client!.simulateCalls({ account: user, calls: batch.map(({ to, data }) => ({ to, data })) })).results,
  explain: explainRevert,
});

/** A write's prepared batch, for whichever component holds the inputs: the store, the chain, and whether it's busy. */
export type TxPrep = { store: PreparedTx; client: Client | undefined; paused: boolean };

const noSubscribe = () => () => {};
const IDLE = idleView();
const idleSnapshot = () => IDLE;

/**
 * Prepares `plan` while the screen is idle: shortly after its inputs settle, then every 15 s while they hold (and when
 * the page comes back into view), never while the write is busy or the page is hidden. `active` false leaves the store
 * to another component. Returns what the button shows for the inputs on screen.
 */
function usePrepareLoop(prep: TxPrep | null, plan: TxPlan | null, active: boolean): PrepView {
  const key = plan?.key ?? null;
  const user = plan?.user ?? null;
  // The newest plan for a key: same key, same batch, so any render's builder will do.
  const latest = useRef(plan);
  useEffect(() => {
    latest.current = plan;
  });
  const store = active ? prep?.store : undefined;
  const client = prep?.client;
  const paused = prep?.paused ?? true;

  useEffect(() => {
    if (!store) return;
    store.setPlan(key, user);
    if (!key || paused || !client) return;
    const run = () => {
      const p = latest.current;
      if (!p || p.key !== key || document.visibilityState === "hidden" || !store.due(key)) return;
      const id = store.begin(key, p.user);
      void checkPlan(p, checkDeps(client)).then((r) => store.finish(id, r));
    };
    const first = setTimeout(run, PREPARE_SETTLE_MS);
    const every = setInterval(run, 1_000);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      document.removeEventListener("visibilitychange", run);
      store.abandon();
    };
  }, [store, key, user, paused, client]);
  // Gone from the screen: nothing it prepared may be signed.
  useEffect(() => () => store?.setPlan(null, null), [store]);

  const snap = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? idleSnapshot, idleSnapshot);
  if (!store || key === null) return idleView(key);
  // The store hears of new inputs after this render; until then they have nothing prepared.
  const view = snap.key === key ? snap : checkingView(key);
  return paused ? { ...view, checking: false } : view;
}

/**
 * For a component that holds the inputs while another holds the write (useTx): prepares `plan` in that write's store.
 * `prep` is the write's `prep`; without one nothing is prepared (the dev gallery).
 */
export function usePrepare(prep: TxPrep | null | undefined, plan: TxPlan | null) {
  const view = usePrepareLoop(prep ?? null, plan, !!prep);
  return { checking: view.checking, blocked: view.blocked, error: view.error };
}

/**
 * The one write path (CLAUDE.md › Transaction safety), one tap to JAW's sheet:
 * build the batch from fresh reads → allowlist (each builder) → join() when due → simulate (eth_simulateV1) → JAW
 * signs once (wallet_sendCalls) → wait → re-read chain state. No optimistic state: "done" only after the batch lands.
 *
 * `plan` is what the screen would sign now (null while it can't): its batch is prepared in the background, and
 * `sign()` sends a batch prepared for exactly that plan's key straight to JAW, with nothing awaited first (Safari opens
 * JAW's popup only inside the tap's activation). Without a fresh one (none yet, or over 30 s old) `sign()` builds and
 * simulates first; if JAW then can't open its popup the batch is kept for that key and the screen says "Tap again to
 * open JAW.". Leave `plan` out when a child component holds the inputs: it prepares them with `usePrepare(tx.prep, …)`,
 * and its tap passes the same plan to `sign(plan)`. When JAW reports `atomic`, every batch requires it (atomicSend). An
 * account's first move also puts it on the leaderboard: GooseBoard.join() rides at the end of that batch, whatever the
 * move is (lib/board/join.ts).
 */
export function useTx(failedOnChain = "This didn’t go through on Base. Nothing moved except any network fee.", plan?: TxPlan | null) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { address } = useAccount();
  const caps = useCapabilities({ account: address, query: { enabled: !!address } });
  const chainCaps = (caps.data as Record<number, ChainCapabilities> | undefined)?.[CHAIN_ID];
  const queryClient = useQueryClient();
  const send = useSendCalls();
  const status = useWaitForCallsStatus({ id: send.data?.id, query: { enabled: !!send.data?.id } });
  const [phase, setPhase] = useState<TxPhase>("idle");
  // An error, and the inputs it was for: "Tap again to open JAW." holds only while those inputs are on screen.
  const [error, setError] = useState<{ text: string; key: string | null } | null>(null);
  const [record, setRecord] = useState<{ user: `0x${string}`; id: string } | null>(null);
  const [store] = useState(() => new PreparedTx());

  const callsStatus = status.data?.status;
  const effective: TxPhase =
    phase === "pending" && callsStatus === "success" ? "done" : phase === "pending" && callsStatus === "failure" ? "failed" : phase;
  const busy = effective === "simulating" || effective === "signing" || effective === "pending";
  const prep: TxPrep = { store, client, paused: busy || effective === "done" };
  const own = usePrepareLoop(prep, plan ?? null, plan !== undefined);
  const onScreen = useSyncExternalStore(store.subscribe, store.getSnapshot, idleSnapshot).key;
  const screenKey = plan !== undefined ? (plan?.key ?? null) : onScreen;

  const tapError = error && !(error.text === TAP_AGAIN && error.key !== screenKey) ? error.text : null;
  const shownError = effective === "failed" && phase === "pending" ? failedOnChain : (tapError ?? (busy ? null : own.error));

  const txHash = status.data?.receipts?.at(-1)?.transactionHash;
  useEffect(() => {
    if (callsStatus === "success") void queryClient.invalidateQueries();
    // The chain moved (or the fee was paid): nothing prepared before it may be signed.
    if (callsStatus === "success" || callsStatus === "failure") store.clear();
    if (record && (callsStatus === "success" || callsStatus === "failure")) {
      updateLocal(record.user, record.id, { status: callsStatus === "success" ? "done" : "failed", hash: txHash });
    }
  }, [callsStatus, queryClient, record, txHash, store]);

  /** The tap: signs `p` (the hook's plan unless given), straight to JAW when it's prepared. */
  function sign(p: TxPlan | null | undefined = plan) {
    const target = p ?? null;
    return signPlan(target, {
      address,
      prepared: store,
      now: Date.now,
      check: (x) => checkPlan(x, checkDeps(client)),
      atomic: (n) => atomicSend(chainCaps, n),
      send: (batch, atomic) => send.mutateAsync({ chainId: CHAIN_ID, calls: batch.map(({ to, data }) => ({ to, data })), ...atomic }),
      setPhase,
      setError: (text) => setError(text === null ? null : { text, key: target?.key ?? null }),
      onSent: (x, id) => {
        if (!x.activity) return;
        addLocal(x.user, { id, time: Date.now(), items: x.activity, status: "pending" });
        setRecord({ user: x.user, id });
      },
    });
  }

  const reset = () => {
    setPhase("idle");
    setError(null);
    send.reset();
  };

  return {
    sign,
    phase: effective,
    error: shownError,
    reset,
    busy,
    txHash,
    /** The plan's first batch is being prepared: the button says "Checking…" and waits. */
    checking: own.checking,
    /** The plan can't go ahead (its simulation reverts, or a stop): the button waits, `error` says why. */
    blocked: own.blocked,
    /** For a child that holds the inputs: `usePrepare(tx.prep, plan)`. */
    prep,
  };
}

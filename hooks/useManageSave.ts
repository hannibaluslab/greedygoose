"use client";

import { useEffect, useRef } from "react";
import { usePublicClient } from "wagmi";
import { useTx, type TxPlan } from "@/hooks/useTx";
import type { useAgents } from "@/hooks/useAgents";
import { usePosition } from "@/hooks/usePosition";
import { readCash } from "@/lib/cash/read";
import { CHAIN_ID } from "@/lib/chain";
import { REGISTER_FALLBACK } from "@/lib/agents/register";
import { rebalanceChange, type MixSave } from "@/lib/agents/rebalanceSettings";
import { startEarningPlan, startEarningPrefix } from "@/lib/startEarning";
import { TxStop, txKey } from "@/lib/tx/prepared";

/**
 * What Rebalance's Save asks for: the mix (`setMix`, when it changed), the job's new grant (when it's needed), and
 * top-ups as chosen, `topUps` (null until the Guard's setting is read) with `topUpsChanged` (`setTopUps`, when they
 * changed) and `topUpsTurningOn`.
 */
export type { MixSave } from "@/lib/agents/rebalanceSettings";

/**
 * Saves Rebalance's settings (its agent sheet) in one batch, one Face ID (Adrian, 2026-10-20: "the permission, the
 * cash move and the registration in one signature"): the mix (`setMix`, when it changed), top-ups (`setTopUps`, when
 * they changed: a switch-only or Keep-only change is settings alone) and a new grant when one is needed, approved and
 * registered with the grant it replaces revoked (useAgents `changePlan`), through the one write path (useTx). Turning
 * top-ups on puts the cash already in the wallet into savings first (Start earning's supply), so only what arrives
 * after goes into the mix, and grants earning in the same batch while it's off (P3). Atomic: one that didn't go through
 * changed nothing. It opens from the tap with nothing awaited before it: the settings body prepares it
 * (`usePrepare(prep, planFor(save))`). `onSaved` runs once it has landed.
 */
export function useManageSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx("This didn’t go through on Base. Nothing changed. Try again.");
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { data: position } = usePosition(account);
  const live = useRef({ onSaved, reset: tx.reset });
  useEffect(() => {
    live.current = { onSaved, reset: tx.reset };
  });
  // Landed: saved, once, and the write goes back to idle, so the body prepares the next Save's batch.
  const saved = useRef(false);
  useEffect(() => {
    if (tx.phase !== "done" || saved.current) return;
    saved.current = true;
    live.current.onSaved();
    live.current.reset();
  }, [tx.phase]);

  /**
   * The save's one batch, for useTx; null when there's nothing to save or earning's state still loads. Built in
   * render, so a setting that can't be built is said at the button, never thrown.
   */
  function planFor(p: MixSave): TxPlan | null {
    let change: ReturnType<typeof rebalanceChange>;
    try {
      change = rebalanceChange(account, p, { save: agents.status.save });
    } catch {
      return {
        key: txKey("rebalance-stop", account),
        user: account,
        calls: () => Promise.reject(new TxStop(REGISTER_FALLBACK)),
      };
    }
    if (!change) return null;
    if (!p.topUpsTurningOn) return agents.changePlan(change);
    // Turning top-ups on: the wallet's cash goes into savings first, read again while the batch is prepared. Under
    // Start earning's smallest amount there's nothing to put away.
    if (!position || !client) return null;
    const readWallet = async (user: `0x${string}`) => (await readCash(client, user)).walletRaw;
    const supply = startEarningPlan(account, position.cash.walletRaw, readWallet);
    return agents.changePlan(supply ? { ...change, prefix: startEarningPrefix(supply) } : change);
  }

  function save(p: MixSave) {
    const plan = planFor(p);
    if (!plan) return;
    saved.current = false;
    if (tx.phase === "failed") tx.reset();
    void tx.sign(plan);
  }

  return {
    save,
    phase: tx.phase,
    error: tx.error,
    busy: tx.busy,
    /** For the settings body: the write's store, and the save's batch to prepare while it's idle. */
    prep: tx.prep,
    planFor,
  };
}

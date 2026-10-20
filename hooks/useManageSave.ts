"use client";

import { useEffect, useRef } from "react";
import { useTx, type TxPlan } from "@/hooks/useTx";
import type { useAgents } from "@/hooks/useAgents";
import { REGISTER_FALLBACK } from "@/lib/agents/register";
import { rebalanceChange, type MixSave } from "@/lib/agents/rebalanceSettings";
import { TxStop, txKey } from "@/lib/tx/prepared";

/**
 * What Rebalance's Save asks for: the mix (`setMix`, when it changed), the job's new grant (when it's needed, with
 * top-ups while they're on), and top-ups as chosen, `topUps` (null until the executor counts them) with
 * `topUpsChanged` (`setTopUps`, when they changed).
 */
export type { MixSave } from "@/lib/agents/rebalanceSettings";

/**
 * Saves Rebalance's settings (its agent sheet) in one batch, one Face ID (Adrian, 2026-10-20: "the permission, the
 * cash move and the registration in one signature"): the mix (`setMix`, when it changed), top-ups (`setTopUps`, when
 * they changed; Keep alone is a settings-only batch) and a new grant when one is needed (turning top-ups on or off is
 * one, carrying or dropping the savings withdraw), approved and registered with the grant it replaces revoked (useAgents
 * `changePlan`), through the one write path (useTx). Turning top-ups on while earning is off grants earning in the same
 * batch (P3: only Save counts top-ups). Atomic: one that didn't go through changed nothing. It opens from the tap with
 * nothing awaited before it: the settings body prepares it (`usePrepare(prep, planFor(save))`). `onSaved` runs once it
 * has landed.
 */
export function useManageSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx("This didn’t go through on Base. Nothing changed. Try again.");
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
      change = rebalanceChange(account, p, { save: agents.status.save, capMaxRaw: agents.capMaxRaw });
    } catch {
      return {
        key: txKey("rebalance-stop", account),
        user: account,
        calls: () => Promise.reject(new TxStop(REGISTER_FALLBACK)),
      };
    }
    return change && agents.changePlan(change);
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

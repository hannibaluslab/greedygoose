"use client";

import { useEffect, useRef } from "react";
import { useTx, type TxPlan } from "@/hooks/useTx";
import type { GrantStep, useAgents } from "@/hooks/useAgents";
import { buildSetMixCalls } from "@/lib/agents/settings";

/** What Rebalance's Save asks for: the mix (`setMix`, when it changed) and the job's new grant (when it's needed). */
export type MixSave = { weights: readonly number[]; mixChanged: boolean; grant: GrantStep | null };

/**
 * Saves Rebalance's settings (its agent sheet) in one batch, one Face ID (Adrian, 2026-10-20: "the permission, the
 * cash move and the registration in one signature"): the mix (`setMix`, when it changed) and a new grant when one is
 * needed, approved and registered with the grant it replaces revoked (useAgents `changePlan`), through the one write
 * path (useTx). Atomic: one that didn't go through changed nothing. It opens from the tap with nothing awaited before
 * it: the settings body prepares it (`usePrepare(prep, planFor(save))`). `onSaved` runs once it has landed.
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

  /** The save's one batch, for useTx; null when there's nothing to save. */
  function planFor(p: MixSave): TxPlan | null {
    if (!p.grant && !p.mixChanged) return null;
    return agents.changePlan({
      grants: p.grant ? [p.grant] : [],
      settings: p.mixChanged ? buildSetMixCalls(account, p.weights) : [],
    });
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

"use client";

import { useEffect, useRef } from "react";
import { useTx, type TxPlan } from "@/hooks/useTx";
import type { useAgents } from "@/hooks/useAgents";
import { protectBatch, type ProtectStep } from "@/lib/agents/protect";
import { buildSetKeepMixCalls } from "@/lib/agents/settings";

/**
 * Saves Protect's settings (lib/agents/protect.ts `protectSteps`) in one batch, one Face ID (`protectBatch`, useAgents
 * `changePlan`, Adrian 2026-10-20): each new grant approved and registered, the grant it replaces and selling's grants
 * when it's switched off revoked, and "Sells first", through the one write path (useTx). The batch is atomic: one that
 * didn't go through changed nothing, and the next Save sends it again. It opens from the tap with nothing awaited
 * before it: the settings body prepares it (`usePrepare(prep, planFor(steps))`). `onSaved` runs once it has landed.
 */
export function useProtectSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
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

  /** The save's one batch for `steps`, for useTx; null when there's nothing to save. */
  function planFor(steps: readonly ProtectStep[]): TxPlan | null {
    const batch = protectBatch(steps);
    if (!batch) return null;
    return agents.changePlan({
      grants: batch.grants,
      off: batch.off,
      settings: batch.keepMix === undefined ? [] : buildSetKeepMixCalls(account, batch.keepMix),
    });
  }

  function save(steps: readonly ProtectStep[]) {
    const plan = planFor(steps);
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

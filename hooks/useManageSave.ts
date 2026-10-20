"use client";

import { useEffect, useRef, useState } from "react";
import { TAP_AGAIN, useTx, type TxPhase, type TxPlan } from "@/hooks/useTx";
import { runError, runStep, runSteps, type AgentStep } from "@/hooks/useAgentRun";
import type { useAgents } from "@/hooks/useAgents";
import type { AgentJob, StockLimits } from "@/lib/agents/permissions";
import { rebalanceSteps } from "@/lib/agents/rebalanceSettings";
import { buildSetMixCalls } from "@/lib/agents/settings";
import { AgentStop } from "@/lib/agents/status";
import { isPopupBlocked } from "@/lib/tx/prepared";
import { setMixPlan } from "@/lib/tx/plans";

/** A job's new grant: its limit, and each stock's for Protect · sell and the Rebalancer. */
export type GrantStep = { job: AgentJob; capRaw: bigint; limitsRaw?: StockLimits };

/** What Rebalance's Save asks for: the mix (`setMix`, when it changed) and the job's new grant (when it's needed). */
type MixSave = { weights: readonly number[]; mixChanged: boolean; grant: GrantStep | null };

const CANCELLED = /reject|denied|cancel/i;

/** What a Save that stopped says, from how many of its JAW sheets went through. */
function stopText(done: number, of: number, error: unknown): string {
  if (isPopupBlocked(error)) return done > 0 ? runError(done, of, error) : TAP_AGAIN;
  if (done > 0 || error instanceof AgentStop) return runError(done, of, error);
  return error instanceof Error && CANCELLED.test(error.message)
    ? "You cancelled. Nothing changed."
    : "We couldn’t save this right now. Try again.";
}

/**
 * Saves Rebalance's settings (its agent sheet) as `rebalanceSteps` says, at most two JAW sheets (Adrian, 2026-10-20:
 * "Batch those into one"): with a new grant, the grant on JAW's own screen (D14: a grant is its own user operation and
 * can't ride in a batch), then one batch with the mix (`setMix`, when it changed) and the grant's registration; with
 * none, the mix alone through the one write path (useTx). When that batch doesn't go through, the grant waits for it
 * (`registering`): the next Save sends the batch, with the mix on screen then, and nothing else. `onSaved` runs once
 * everything has landed.
 *
 * The first JAW sheet opens from the tap with nothing awaited before it: the settings body prepares the `setMix` batch
 * (`usePrepare(prep, settingPlan(weights))`), and a grant's request is built in the tap itself. The batch after a grant
 * starts on its own; where JAW opens a popup only inside a tap (Safari) it can't, so the screen says "Tap again to open
 * JAW." and the next Save sends it (useAgents keeps it ready for that tap).
 */
export function useManageSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx();
  const [step, setStep] = useState<"idle" | "setting" | "granting">("idle");
  // A Save that stopped part way: how many of its JAW sheets went through, of how many, and why it stopped.
  const [stopped, setStopped] = useState<{ done: number; of: number; error: unknown } | null>(null);
  // This sheet's grant landed and its batch didn't: the next Save sends the batch.
  const [registering, setRegistering] = useState(false);
  // The latest callback and reset, so the effect below doesn't re-run on every render's new object.
  const live = useRef({ onSaved, resetTx: tx.reset });
  useEffect(() => {
    live.current = { onSaved, resetTx: tx.reset };
  });

  // The mix landed (a Save with no grant): saved, once, and the write goes back to idle for the next Save.
  const landed = useRef(false);
  useEffect(() => {
    if (step !== "setting" || tx.phase !== "done" || landed.current) return;
    landed.current = true;
    void Promise.resolve().then(() => {
      setStep("idle");
      live.current.onSaved();
      live.current.resetTx();
    });
  }, [step, tx.phase]);

  /** The grant and the batch, from this tap (`before`: the JAW sheets of the Save this one goes on from). */
  const runNow = (steps: readonly AgentStep[], before: { done: number; of: number }) => {
    setStep("granting");
    setStopped(null);
    runSteps(steps, (s) => runStep(agents, s))
      .then((r) => {
        if (r.rest.length === 0) {
          setRegistering(false);
          return onSaved();
        }
        // A grant that landed waits for its batch, and one from an earlier Save of this sheet still does.
        setRegistering((was) => was || r.rest.every((s) => "register" in s));
        setStopped({ done: before.done + r.done, of: before.of, error: r.error });
      })
      .finally(() => setStep("idle"));
  };

  function save(p: MixSave) {
    const job: AgentJob = p.grant?.job ?? "rebalance";
    const settings = p.mixChanged ? buildSetMixCalls(account, p.weights) : [];
    const plan = rebalanceSteps({ needsGrant: !!p.grant, mixChanged: p.mixChanged, waiting: registering });
    const steps: AgentStep[] = plan.flatMap((k): AgentStep[] =>
      k === "grant" && p.grant ? [{ grant: p.grant }] : k === "batch" ? [{ register: [job], settings }] : [],
    );
    tx.reset();
    if (steps.length > 0) {
      // Going on from a Save whose grant landed: this tap's batch is the last of its sheets.
      const goOn = registering && !p.grant && stopped ? stopped : null;
      return runNow(steps, goOn ? { done: goOn.done, of: goOn.of } : { done: 0, of: steps.length });
    }
    setStopped(null);
    if (!plan.includes("mix")) return;
    // The mix saved alone: a batch that stopped earlier no longer carries what the user wants.
    agents.forgetSettings("rebalance");
    landed.current = false;
    setStep("setting");
    void tx.sign(setMixPlan(account, p.weights));
  }

  const phase: TxPhase =
    step === "granting" || (step === "setting" && tx.phase === "done")
      ? "signing"
      : step === "setting"
        ? tx.phase
        : "idle";
  const grantError = stopped ? stopText(stopped.done, stopped.of, stopped.error) : null;
  return {
    save,
    phase,
    error: step === "setting" && tx.phase !== "done" ? tx.error : step === "idle" ? (tx.error ?? grantError) : null,
    busy: phase === "simulating" || phase === "signing" || phase === "pending",
    /** This sheet's grant waits for its batch: Save sends it (`rebalanceSave`'s `waiting`). */
    registering,
    /** For the settings body: the write's store, and the `setMix` batch to prepare (none while a batch is left). */
    prep: tx.prep,
    settingPlan: (weights: readonly number[]): TxPlan | null => (registering ? null : setMixPlan(account, weights)),
  };
}

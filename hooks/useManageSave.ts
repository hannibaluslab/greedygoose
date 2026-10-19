"use client";

import { useEffect, useRef, useState } from "react";
import { TAP_AGAIN, txKey, useTx, type TxPhase, type TxPlan } from "@/hooks/useTx";
import { runError } from "@/hooks/useAgentRun";
import type { useAgents } from "@/hooks/useAgents";
import type { AgentJob, StockLimits } from "@/lib/agents/permissions";
import { isPopupBlocked } from "@/lib/tx/prepared";
import { setMixPlan } from "@/lib/tx/plans";

/** A job's new grant: its limit, and each stock's for Protect · sell and the Rebalancer. */
export type GrantStep = { job: AgentJob; capRaw: bigint; limitsRaw?: StockLimits };

/** What Rebalance's Save asks for: the mix (`setMix`, when it changed) and the job's new grant (when it's needed). */
type MixSave = { weights: readonly number[]; mixChanged: boolean; grant: GrantStep | null };

const CANCELLED = /reject|denied|cancel/i;

/** One grant on JAW's own screen; its request is built here, with nothing awaited before JAW is called. */
const openGrant = (agents: ReturnType<typeof useAgents>, g: GrantStep) => agents.turnOn(g.job, g.capRaw, g.limitsRaw);

/**
 * Saves Rebalance's settings (its agent sheet) in at most two JAW sheets, each only when it's needed: first the mix
 * (`setMix`) through the one write path (useTx), then the job's new grant on JAW's own screen (D14: a grant is its own
 * user operation and can't ride in a batch). `onSaved` runs once both have landed. Protect's has its own steps
 * (useProtectSave).
 *
 * Each JAW sheet opens from a tap with nothing awaited before it: the settings body prepares the `setMix` batch
 * (`usePrepare(prep, settingPlan(weights))`), and a grant's request is built in the tap itself. The grant after a
 * landed mix starts on its own; where JAW opens a popup only inside a tap (Safari) it can't, so the screen says "Tap
 * again to open JAW." and the next Save opens that grant alone.
 */
export function useManageSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx();
  const [step, setStep] = useState<"idle" | "setting" | "granting">("idle");
  const [grant, setGrant] = useState<GrantStep | null>(null);
  // The mix landed, its grant didn't open: the next Save opens it alone (`asked` is what that Save asked for; `done`
  // of `of` JAW sheets went through).
  const [pending, setPending] = useState<{ asked: string; grant: GrantStep; done: number; of: number } | null>(null);
  const asked = useRef("");
  const launched = useRef(false);
  // The latest agents, callback and reset, so the effect below doesn't re-run on every render's new object.
  const live = useRef({ agents, onSaved, resetTx: tx.reset });
  useEffect(() => {
    live.current = { agents, onSaved, resetTx: tx.reset };
  });

  // The setting landed: on to the grant, once.
  useEffect(() => {
    if (step !== "setting" || tx.phase !== "done" || launched.current) return;
    launched.current = true;
    const ask = asked.current;
    (grant ? openGrant(live.current.agents, grant) : Promise.resolve())
      .then(
        () => {
          setPending(null);
          live.current.onSaved();
        },
        (e: unknown) => {
          // useAgents keeps the error for the screen; a grant JAW couldn't open waits for the next tap.
          if (grant && isPopupBlocked(e)) setPending({ asked: ask, grant, done: 1, of: 2 });
        },
      )
      .finally(() => {
        setStep("idle");
        // The mix's batch is behind us: the write goes back to idle, so the body prepares the next Save's again.
        live.current.resetTx();
      });
  }, [step, tx.phase, grant]);

  /** A grant from this tap (`count`: the JAW sheets of this Save so far, when it goes on from one that didn't open). */
  const grantNow = (g: GrantStep, ask: string, count = { done: 0, of: 1 }) => {
    setStep("granting");
    openGrant(agents, g)
      .then(
        () => {
          setPending(null);
          onSaved();
        },
        (e: unknown) => {
          if (isPopupBlocked(e)) setPending({ asked: ask, grant: g, ...count });
        },
      )
      .finally(() => setStep("idle"));
  };

  function save(p: MixSave) {
    const key = txKey(p.mixChanged ? p.weights : null, p.grant);
    // The mix already landed and only its grant is left: from this tap, with the screen's newest terms once it re-read.
    if (pending && (pending.asked === key || !p.mixChanged)) {
      grantNow(!p.mixChanged && p.grant ? p.grant : pending.grant, pending.asked, {
        done: pending.done,
        of: pending.of,
      });
      return;
    }
    tx.reset();
    setPending(null);
    launched.current = false;
    asked.current = key;
    setGrant(p.grant);
    if (p.mixChanged) {
      setStep("setting");
      void tx.sign(setMixPlan(account, p.weights));
    } else if (p.grant) {
      grantNow(p.grant, key);
    }
  }

  const phase: TxPhase =
    step === "granting" || (step === "setting" && tx.phase === "done")
      ? "signing"
      : step === "setting"
        ? tx.phase
        : "idle";
  const grantError = agents.error
    ? isPopupBlocked(agents.error)
      ? pending && pending.done > 0
        ? runError(pending.done, pending.of, agents.error)
        : TAP_AGAIN
      : CANCELLED.test(agents.error.message)
        ? "You cancelled. Its limit didn’t change."
        : "We couldn’t change its limit right now. Try again."
    : null;
  return {
    save,
    phase,
    error: step === "setting" && tx.phase !== "done" ? tx.error : step === "idle" ? (tx.error ?? grantError) : null,
    busy: phase === "simulating" || phase === "signing" || phase === "pending",
    /** For the settings body: the write's store, and the `setMix` batch to prepare (none while only a grant is left). */
    prep: tx.prep,
    settingPlan: (weights: readonly number[]): TxPlan | null => (pending ? null : setMixPlan(account, weights)),
  };
}

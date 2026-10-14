"use client";

import { useEffect, useRef, useState } from "react";
import { useTx, type TxPhase } from "@/hooks/useTx";
import type { useAgents } from "@/hooks/useAgents";
import type { Call } from "@/lib/aave/tx";
import type { AgentJob, StockLimits } from "@/lib/agents/permissions";

/** A job's new grant: its limit, and each stock's for Protect · sell and the Rebalancer. */
export type GrantStep = { job: AgentJob; capRaw: bigint; limitsRaw?: StockLimits };

const CANCELLED = /reject|denied|cancel/i;

/**
 * Saves Rebalance's settings (its agent sheet) in at most two Face IDs, each only when it's needed: first the mix
 * (`setMix`) through the one write path (useTx), then the job's new grant on JAW's own screen (D14: a grant is its own
 * user operation and can't ride in a batch). `onSaved` runs once both have landed. Protect's has its own steps
 * (useProtectSave).
 */
export function useManageSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx();
  const [step, setStep] = useState<"idle" | "setting" | "granting">("idle");
  const [grant, setGrant] = useState<GrantStep | null>(null);
  const launched = useRef(false);

  // The setting landed: on to the grant, once.
  useEffect(() => {
    if (step !== "setting" || tx.phase !== "done" || launched.current) return;
    launched.current = true;
    (grant ? agents.turnOn(grant.job, grant.capRaw, grant.limitsRaw) : Promise.resolve())
      .then(onSaved, () => {}) // useAgents keeps the error for the screen
      .finally(() => setStep("idle"));
  }, [step, tx.phase, grant, agents, onSaved]);

  function save(p: { calls: Call[] | null; grant: GrantStep | null }) {
    tx.reset();
    launched.current = false;
    setGrant(p.grant);
    if (p.calls) {
      setStep("setting");
      void tx.run(account, p.calls);
    } else if (p.grant) {
      setStep("granting");
      agents
        .turnOn(p.grant.job, p.grant.capRaw, p.grant.limitsRaw)
        .then(onSaved, () => {})
        .finally(() => setStep("idle"));
    }
  }

  const phase: TxPhase =
    step === "granting" || (step === "setting" && tx.phase === "done") ? "signing" : step === "setting" ? tx.phase : "idle";
  const grantError = agents.error
    ? CANCELLED.test(agents.error.message)
      ? "You cancelled on JAW’s screen. Its limit didn’t change."
      : "We couldn’t change its limit right now. Try again."
    : null;
  return {
    save,
    phase,
    error: step === "setting" && tx.phase !== "done" ? tx.error : step === "idle" ? (tx.error ?? grantError) : null,
    busy: phase === "simulating" || phase === "signing" || phase === "pending",
  };
}

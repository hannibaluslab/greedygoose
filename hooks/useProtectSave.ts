"use client";

import { useEffect, useRef, useState } from "react";
import { useTx, type TxPhase } from "@/hooks/useTx";
import type { useAgents } from "@/hooks/useAgents";
import type { ProtectStep } from "@/lib/agents/protect";
import { buildSetKeepMixCalls } from "@/lib/agents/settings";

const CANCELLED = /reject|denied|cancel/i;

/** Each grant or revoke in order, on JAW's own screen; the first that fails stops the rest. */
async function runGrants(agents: ReturnType<typeof useAgents>, steps: readonly ProtectStep[]) {
  for (const s of steps) {
    if (s.kind === "revoke") await agents.turnOff(s.job);
    else if (s.kind === "grant") await agents.turnOn(s.job, s.capRaw, s.job === "sell" ? s.limitsRaw : undefined);
  }
}

/**
 * Saves Protect's settings, one Face ID a step (lib/agents/protect.ts `protectSteps`): "Sells first" through the one
 * write path (useTx, `setKeepMix`), then each grant or revoke on JAW's own screen (D14), in order. `onSaved` runs once
 * every step has landed; a step that fails stops the rest, and the screen then offers only what is still to save.
 */
export function useProtectSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx();
  const [step, setStep] = useState<"idle" | "setting" | "granting">("idle");
  const rest = useRef<ProtectStep[]>([]);
  const launched = useRef(false);
  // The latest agents and callback, so the effect below doesn't re-run on every render's new object.
  const live = useRef({ agents, onSaved });
  useEffect(() => {
    live.current = { agents, onSaved };
  });

  // The setting landed: on to the grants, once.
  useEffect(() => {
    if (step !== "setting" || tx.phase !== "done" || launched.current) return;
    launched.current = true;
    runGrants(live.current.agents, rest.current)
      .then(() => live.current.onSaved(), () => {}) // useAgents keeps the error for the screen
      .finally(() => setStep("idle"));
  }, [step, tx.phase]);

  function save(steps: readonly ProtectStep[]) {
    tx.reset();
    launched.current = false;
    const [first, ...others] = steps;
    if (!first) return;
    if (first.kind === "keepMix") {
      rest.current = others;
      setStep("setting");
      void tx.run(account, buildSetKeepMixCalls(account, first.on));
      return;
    }
    setStep("granting");
    runGrants(agents, steps)
      .then(() => live.current.onSaved(), () => {})
      .finally(() => setStep("idle"));
  }

  const phase: TxPhase =
    step === "granting" || (step === "setting" && tx.phase === "done") ? "signing" : step === "setting" ? tx.phase : "idle";
  const grantError = agents.error
    ? CANCELLED.test(agents.error.message)
      ? "You cancelled on JAW’s screen. Nothing after it changed."
      : "We couldn’t save this right now. Try again."
    : null;
  return {
    save,
    phase,
    error: step === "setting" && tx.phase !== "done" ? tx.error : step === "idle" ? (tx.error ?? grantError) : null,
    busy: phase === "simulating" || phase === "signing" || phase === "pending",
  };
}

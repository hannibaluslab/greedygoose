"use client";

import { useEffect, useRef, useState } from "react";
import { TAP_AGAIN, txKey, useTx, type TxPhase, type TxPlan } from "@/hooks/useTx";
import { runError } from "@/hooks/useAgentRun";
import type { useAgents } from "@/hooks/useAgents";
import type { ProtectStep } from "@/lib/agents/protect";
import { buildSetKeepMixCalls } from "@/lib/agents/settings";
import { isPopupBlocked } from "@/lib/tx/prepared";

const CANCELLED = /reject|denied|cancel/i;

/** "Sells first" (`setKeepMix`), as useTx signs it: keyed by the account and the choice. */
export const keepMixPlan = (account: `0x${string}`, on: boolean): TxPlan => ({
  key: txKey("keepMix", account, on),
  user: account,
  calls: () => Promise.resolve(buildSetKeepMixCalls(account, on)),
});

/**
 * Each grant or revoke in order, on JAW's own screen; the first that fails stops the rest. Each request is built as
 * it's sent, so the first one is called straight from the tap that asked for it.
 */
async function runGrants(
  agents: ReturnType<typeof useAgents>,
  steps: readonly ProtectStep[],
): Promise<{ rest: ProtectStep[]; error: unknown }> {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      if (s.kind === "revoke") await agents.turnOff(s.job);
      else if (s.kind === "grant") await agents.turnOn(s.job, s.capRaw, s.job === "sell" ? s.limitsRaw : undefined);
    } catch (error) {
      return { rest: steps.slice(i), error };
    }
  }
  return { rest: [], error: null };
}

/**
 * Saves Protect's settings, one JAW sheet a step (lib/agents/protect.ts `protectSteps`): "Sells first" through the one
 * write path (useTx, `setKeepMix`), then each grant or revoke on JAW's own screen (D14), in order. `onSaved` runs once
 * every step has landed; a step that fails stops the rest, and the screen then offers only what is still to save.
 *
 * Each JAW sheet opens from a tap with nothing awaited before it: the settings body prepares the `setKeepMix` batch
 * (`usePrepare(prep, settingPlan(on))`), and a grant's or revoke's request is built in the tap itself. The steps after
 * the first start on their own; where JAW opens a popup only inside a tap (Safari) they can't, so the screen says "Tap
 * again to open JAW." and the next Save goes on with the steps still to do.
 */
export function useProtectSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx();
  const [step, setStep] = useState<"idle" | "setting" | "granting">("idle");
  // What's left after a step JAW couldn't open, for the next Save (`asked` is what that Save asked for; `done` of `of`
  // JAW sheets went through).
  const [pending, setPending] = useState<{ asked: string; rest: ProtectStep[]; done: number; of: number } | null>(null);
  const rest = useRef<ProtectStep[]>([]);
  const asked = useRef("");
  const launched = useRef(false);
  // The latest agents, callback and reset, so the effect below doesn't re-run on every render's new object.
  const live = useRef({ agents, onSaved, resetTx: tx.reset });
  useEffect(() => {
    live.current = { agents, onSaved, resetTx: tx.reset };
  });

  // The setting landed: on to the grants, once.
  useEffect(() => {
    if (step !== "setting" || tx.phase !== "done" || launched.current) return;
    launched.current = true;
    const ask = asked.current;
    const steps = rest.current;
    // "Sells first" was the first of this Save's JAW sheets.
    const of = 1 + steps.length;
    runGrants(live.current.agents, steps)
      .then((r) => {
        if (r.rest.length === 0) {
          setPending(null);
          live.current.onSaved();
        } else if (isPopupBlocked(r.error)) {
          setPending({ asked: ask, rest: r.rest, done: of - r.rest.length, of });
        } // otherwise useAgents keeps the error for the screen
      })
      .finally(() => {
        setStep("idle");
        // The setting's batch is behind us: the write goes back to idle, so the body prepares the next Save's again.
        live.current.resetTx();
      });
  }, [step, tx.phase]);

  /** Grants and revokes from this tap (`count`: the JAW sheets of this Save so far, when it goes on from one that didn't open). */
  const grantNow = (steps: readonly ProtectStep[], ask: string, count = { done: 0, of: steps.length }) => {
    setStep("granting");
    runGrants(agents, steps)
      .then((r) => {
        if (r.rest.length === 0) {
          setPending(null);
          onSaved();
        } else
          setPending(
            isPopupBlocked(r.error)
              ? { asked: ask, rest: r.rest, done: count.done + steps.length - r.rest.length, of: count.of }
              : null,
          );
      })
      .finally(() => setStep("idle"));
  };

  function save(steps: readonly ProtectStep[]) {
    const key = txKey(steps);
    // Steps were left after one JAW couldn't open: go on with them (or with the screen's newest steps once it re-read).
    if (pending && (pending.asked === key || !steps.some((s) => s.kind === "keepMix"))) {
      if (pending.asked === key) grantNow(pending.rest, key, { done: pending.done, of: pending.of });
      else grantNow(steps, key);
      return;
    }
    tx.reset();
    setPending(null);
    launched.current = false;
    asked.current = key;
    const [first, ...others] = steps;
    if (!first) return;
    if (first.kind === "keepMix") {
      rest.current = others;
      setStep("setting");
      void tx.sign(keepMixPlan(account, first.on));
      return;
    }
    grantNow(steps, key);
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
        ? "You cancelled. Nothing after it changed."
        : "We couldn’t save this right now. Try again."
    : null;
  return {
    save,
    phase,
    error: step === "setting" && tx.phase !== "done" ? tx.error : step === "idle" ? (tx.error ?? grantError) : null,
    busy: phase === "simulating" || phase === "signing" || phase === "pending",
    /** For the settings body: the write's store, and the `setKeepMix` batch to prepare (none while steps are left). */
    prep: tx.prep,
    settingPlan: (on: boolean): TxPlan | null => (pending ? null : keepMixPlan(account, on)),
  };
}

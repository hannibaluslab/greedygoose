"use client";

import { useEffect, useRef, useState } from "react";
import { TAP_AGAIN, useTx, type TxPhase, type TxPlan } from "@/hooks/useTx";
import { runError } from "@/hooks/useAgentRun";
import type { useAgents } from "@/hooks/useAgents";
import { withRegistration, type ProtectJob, type ProtectStep } from "@/lib/agents/protect";
import { buildSetKeepMixCalls } from "@/lib/agents/settings";
import { AgentStop, OFF_UNREADABLE } from "@/lib/agents/status";
import { isPopupBlocked } from "@/lib/tx/prepared";
import { keepMixPlan } from "@/lib/tx/plans";

const CANCELLED = /reject|denied|cancel/i;

/** What a save that stopped says, from how many of its JAW sheets went through. */
function stopText(done: number, of: number, error: unknown): string {
  if (isPopupBlocked(error)) return done > 0 ? `${done} of ${of} went through. ${TAP_AGAIN}` : TAP_AGAIN;
  if (error instanceof Error && error.message === OFF_UNREADABLE) return OFF_UNREADABLE;
  if (done > 0 || error instanceof AgentStop) return runError(done, of, error);
  return error instanceof Error && CANCELLED.test(error.message)
    ? "You cancelled. Nothing after it changed."
    : "We couldn’t save this right now. Try again.";
}

/** Jobs whose grant landed in a run that stopped before its last batch: what that batch still has to register. */
function waitingAfter(rest: readonly ProtectStep[]): ProtectJob[] {
  const batch = rest.find((s) => s.kind === "register");
  if (!batch || batch.kind !== "register") return [];
  return batch.jobs.filter((j) => !rest.some((s) => s.kind === "grant" && s.job === j));
}

/** JAW sheets the steps open, as the button counts them: a revoke once for each sell grant JAW still lists. */
const weigh = (steps: readonly ProtectStep[], revokes: number) =>
  steps.reduce((n, s) => n + (s.kind === "revoke" ? revokes : 1), 0);

/**
 * Each grant or revoke in order, on JAW's own screen, then the save's last batch ("Sells first" and the registration
 * of what it granted, useAgents `registerJobs`); the first that fails stops the rest. Each request is built as it's
 * sent, so the first one is called straight from the tap that asked for it.
 */
async function runGrants(
  account: `0x${string}`,
  agents: ReturnType<typeof useAgents>,
  steps: readonly ProtectStep[],
): Promise<{ rest: ProtectStep[]; error: unknown }> {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      if (s.kind === "revoke") await agents.turnOff(s.job);
      else if (s.kind === "grant") await agents.grantJob(s.job, s.capRaw, s.job === "sell" ? s.limitsRaw : undefined);
      else if (s.kind === "register")
        await agents.registerJobs(s.jobs, s.keepMix === undefined ? [] : buildSetKeepMixCalls(account, s.keepMix));
    } catch (error) {
      return { rest: steps.slice(i), error };
    }
  }
  return { rest: [], error: null };
}

/**
 * Saves Protect's settings, one JAW sheet a step (lib/agents/protect.ts `protectSteps`, run as `withRegistration`):
 * with nothing to register, "Sells first" through the one write path (useTx, `setKeepMix`), then a revoke; with a grant,
 * each grant or revoke on JAW's own screen (D14), then one batch with "Sells first" and the registrations (Adrian,
 * 2026-10-20: "Batch those into one"). When that batch doesn't go through, this sheet's grants wait for it
 * (`registering`): the next Save sends it with the settings on screen then. A grant from anywhere else is left to the
 * Agents tab's Finish card. `onSaved` runs once every step has landed.
 *
 * Each JAW sheet opens from a tap with nothing awaited before it: the settings body prepares the `setKeepMix` batch
 * (`usePrepare(prep, settingPlan(on))`), and a grant's or revoke's request is built in the tap itself. The steps after
 * the first start on their own; where JAW opens a popup only inside a tap (Safari) they can't, so the screen says "Tap
 * again to open JAW." and the next Save goes on with the steps still to do.
 */
export function useProtectSave(account: `0x${string}`, agents: ReturnType<typeof useAgents>, onSaved: () => void) {
  const tx = useTx();
  const [step, setStep] = useState<"idle" | "setting" | "granting">("idle");
  // A save that stopped: how many of its JAW sheets went through, of how many, and why.
  const [stopped, setStopped] = useState<{ done: number; of: number; error: unknown } | null>(null);
  // This sheet's grants that landed before a batch that didn't: the next Save registers them.
  const [registering, setRegistering] = useState<ProtectJob[]>([]);
  const rest = useRef<ProtectStep[]>([]);
  const launched = useRef(false);
  /**
   * A run's end: saved, or what stopped it and which of this sheet's grants still wait for their batch: those that
   * landed in this run, and those from an earlier run of this sheet unless this one revoked them.
   */
  const settle = (
    plan: readonly ProtectStep[],
    r: { rest: ProtectStep[]; error: unknown },
    done: number,
    of: number,
  ) => {
    if (r.rest.length === 0) {
      setRegistering([]);
      setStopped(null);
      return onSaved();
    }
    const revoked: ProtectJob[] = plan
      .slice(0, plan.length - r.rest.length)
      .flatMap((s) => (s.kind === "revoke" ? [s.job] : []));
    setRegistering((was) => [...new Set([...was.filter((j) => !revoked.includes(j)), ...waitingAfter(r.rest)])]);
    setStopped({ done, of, error: r.error });
  };
  // The latest agents, end and reset, so the effect below doesn't re-run on every render's new object.
  const live = useRef({ agents, settle, resetTx: tx.reset });
  useEffect(() => {
    live.current = { agents, settle, resetTx: tx.reset };
  });

  // The setting landed: on to the revoke, once.
  useEffect(() => {
    if (step !== "setting" || tx.phase !== "done" || launched.current) return;
    launched.current = true;
    const steps = rest.current;
    const revokes = Math.max(1, live.current.agents.faceIdsOff(["sell"]));
    // "Sells first" was the first of this Save's JAW sheets.
    const of = 1 + weigh(steps, revokes);
    runGrants(account, live.current.agents, steps)
      .then((r) => live.current.settle(steps, r, of - weigh(r.rest, revokes), of))
      .finally(() => {
        setStep("idle");
        // The setting's batch is behind us: the write goes back to idle, so the body prepares the next Save's again.
        live.current.resetTx();
      });
  }, [step, tx.phase, account]);

  function save(steps: readonly ProtectStep[]) {
    const plan = withRegistration(steps, registering);
    const revokes = Math.max(1, agents.faceIdsOff(["sell"]));
    // Going on from a save whose grants landed: this tap's sheets, ending in the batch it owes, are the last of its count.
    const before =
      registering.length > 0 && stopped && plan.some((s) => s.kind === "register")
        ? { done: stopped.done, of: stopped.done + weigh(plan, revokes) }
        : null;
    setStopped(null);
    tx.reset();
    launched.current = false;
    const [first, ...others] = plan;
    if (!first) return;
    if (first.kind === "keepMix") {
      // "Sells first" saved alone: a batch that stopped earlier no longer carries what the user wants.
      agents.forgetSettings("protect");
      agents.forgetSettings("sell");
      rest.current = others;
      setStep("setting");
      void tx.sign(keepMixPlan(account, first.on));
      return;
    }
    const count = before ?? { done: 0, of: weigh(plan, revokes) };
    setStep("granting");
    runGrants(account, agents, plan)
      .then((r) => settle(plan, r, count.done + weigh(plan, revokes) - weigh(r.rest, revokes), count.of))
      .finally(() => setStep("idle"));
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
    /** This sheet's grants waiting for their batch: Save registers them (`withRegistration`'s `waiting`). */
    registering,
    /** For the settings body: the write's store, and the `setKeepMix` batch to prepare (none while a batch is left). */
    prep: tx.prep,
    settingPlan: (on: boolean): TxPlan | null => (registering.length > 0 ? null : keepMixPlan(account, on)),
  };
}

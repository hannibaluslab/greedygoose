"use client";

import { useState } from "react";
import type { useAgents } from "@/hooks/useAgents";
import type { GrantStep } from "@/hooks/useManageSave";
import type { AgentJob } from "@/lib/agents/permissions";
import { TAP_AGAIN, isPopupBlocked } from "@/lib/tx/prepared";

/** One JAW screen: a job's new grant, or turning a job off (each of its grants revoked). */
export type AgentStep = { grant: GrantStep } | { off: AgentJob };

const CANCELLED = /reject|denied|cancel/i;

/** Runs `steps` in order with `exec`, stopping at the first that throws: how many went through, the rest, and why. */
export async function runSteps(
  steps: readonly AgentStep[],
  exec: (s: AgentStep) => Promise<unknown>,
): Promise<{ done: number; rest: AgentStep[]; error: unknown }> {
  let done = 0;
  try {
    for (const s of steps) {
      await exec(s);
      done += 1;
    }
  } catch (error) {
    // stop here: the caller offers the rest
    return { done, rest: steps.slice(done), error };
  }
  return { done, rest: [], error: null };
}

/**
 * What a change that stopped says: how many of its JAW sheets went through, and whether the user cancelled one. A sheet
 * JAW couldn't open (Safari opens its popup only inside a tap, and the steps after the first come after one) is no
 * failure: "Tap again to open JAW.", and the next tap opens it.
 */
export function runError(done: number, of: number, error: unknown): string {
  if (isPopupBlocked(error)) return done > 0 ? `${done} of ${of} went through. ${TAP_AGAIN}` : TAP_AGAIN;
  const cancelled = error instanceof Error && CANCELLED.test(error.message);
  if (done > 0) return `${done} of ${of} went through, then ${cancelled ? "you cancelled on JAW’s screen" : "the next one didn’t"}. Try again for the rest.`;
  return cancelled ? "You cancelled on JAW’s screen. Nothing changed." : "We couldn’t do that right now. Nothing changed. Try again.";
}

/**
 * Runs an agent change on JAW's own sheets, one for each grant or revoke (D14: each is its own user operation), in
 * order, straight from the button that asks for it (the first request is built in the tap, with nothing awaited before
 * JAW is called), stopping at the first that doesn't go through. `key` names the change: trying the same one again
 * runs only the steps that didn't, as they were first asked for (the steps the screen rebuilds from the chain leave out
 * a job that is already off, so counting into them would skip one that is still on). `prior` counts JAW sheets of the
 * same change that went through before this run (Start earning's batch, before its grant), so a stop reads "1 of 2
 * went through". `run` resolves to the error it shows, or null once every step went through.
 */
export function useAgentRun(agents: ReturnType<typeof useAgents>) {
  const [running, setRunning] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; done: number; of: number; rest: readonly AgentStep[]; message: string } | null>(null);

  async function run(key: string, steps: readonly AgentStep[], onDone: () => void, prior = 0): Promise<string | null> {
    const retry = failed?.key === key ? failed : null;
    const todo = retry?.rest ?? steps;
    const before = retry?.done ?? prior;
    const of = retry?.of ?? prior + steps.length;
    setRunning(key);
    setFailed(null);
    try {
      const r = await runSteps(todo, (s) =>
        "grant" in s ? agents.turnOn(s.grant.job, s.grant.capRaw, s.grant.limitsRaw) : agents.turnOff(s.off),
      );
      if (r.rest.length === 0) {
        onDone();
        return null;
      }
      const done = before + r.done;
      const message = runError(done, of, r.error);
      setFailed({ key, done, of, rest: r.rest, message });
      return message;
    } finally {
      setRunning(null);
    }
  }

  return {
    run,
    /** A change is on JAW's sheet now. */
    running: running !== null,
    /** Whether the change named `prefix…` is running, or what stopped it. */
    runningFor: (prefix: string) => running?.startsWith(prefix) ?? false,
    errorFor: (prefix: string) => (failed?.key.startsWith(prefix) ? failed.message : null),
    /** Forgets what stopped the last change, for a screen that asks for it afresh. */
    reset: () => setFailed(null),
  };
}

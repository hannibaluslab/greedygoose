"use client";

import { useState } from "react";
import type { useAgents } from "@/hooks/useAgents";
import type { GrantStep } from "@/hooks/useManageSave";
import type { AgentJob } from "@/lib/agents/permissions";

/** One JAW screen: a job's new grant, or turning a job off (each of its grants revoked). */
export type AgentStep = { grant: GrantStep } | { off: AgentJob };

const CANCELLED = /reject|denied|cancel/i;

/** Runs `steps` in order with `exec`, stopping at the first that throws: how many went through, and the rest. */
export async function runSteps(
  steps: readonly AgentStep[],
  exec: (s: AgentStep) => Promise<unknown>,
): Promise<{ done: number; rest: AgentStep[] }> {
  let done = 0;
  try {
    for (const s of steps) {
      await exec(s);
      done += 1;
    }
  } catch {
    // stop here: the caller offers the rest
  }
  return { done, rest: steps.slice(done) };
}

/**
 * Runs an agent change on JAW's own screens, one Face ID each (D14: a grant or a revoke is its own user operation),
 * in order, stopping at the first that doesn't go through. Trying again runs only the steps that didn't, as they were
 * first asked for: the steps the screen rebuilds from the chain leave out a job that is already off, so counting into
 * them would skip one that is still on. `reset` before a different change.
 */
export function useAgentRun(agents: ReturnType<typeof useAgents>) {
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<{ done: number; of: number; rest: readonly AgentStep[] } | null>(null);

  async function run(steps: readonly AgentStep[], onDone: () => void) {
    const todo = failed?.rest ?? steps;
    const before = failed?.done ?? 0;
    const of = failed?.of ?? steps.length;
    setRunning(true);
    setFailed(null);
    try {
      const r = await runSteps(todo, (s) =>
        "grant" in s ? agents.turnOn(s.grant.job, s.grant.capRaw, s.grant.limitsRaw) : agents.turnOff(s.off),
      );
      if (r.rest.length === 0) onDone();
      else setFailed({ done: before + r.done, of, rest: r.rest });
    } finally {
      setRunning(false);
    }
  }

  const cancelled = !!agents.error && CANCELLED.test(agents.error.message);
  const error = !failed
    ? null
    : failed.done > 0
      ? `${failed.done} of ${failed.of} went through, then ${cancelled ? "you cancelled on JAW’s screen" : "the next one didn’t"}. Try again for the rest.`
      : cancelled
        ? "You cancelled on JAW’s screen. Nothing changed."
        : "We couldn’t do that right now. Nothing changed. Try again.";
  return { run, running, error, reset: () => setFailed(null) };
}

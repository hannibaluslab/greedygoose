"use client";

import { useState } from "react";
import type { useAgents } from "@/hooks/useAgents";
import type { GrantStep } from "@/hooks/useManageSave";
import type { AgentJob } from "@/lib/agents/permissions";

/** One JAW screen: a job's new grant, or turning a job off (each of its grants revoked). */
export type AgentStep = { grant: GrantStep } | { off: AgentJob };

const CANCELLED = /reject|denied|cancel/i;

/**
 * Runs an agent change on JAW's own screens, one Face ID each (D14: a grant or a revoke is its own user operation),
 * in order, stopping at the first that doesn't go through. Trying again picks up where it stopped; `reset` before a
 * different change.
 */
export function useAgentRun(agents: ReturnType<typeof useAgents>) {
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<{ done: number; of: number } | null>(null);

  async function run(steps: readonly AgentStep[], onDone: () => void) {
    const from = failed?.done ?? 0;
    setRunning(true);
    setFailed(null);
    let done = from;
    try {
      for (const s of steps.slice(from)) {
        if ("grant" in s) await agents.turnOn(s.grant.job, s.grant.capRaw, s.grant.limitsRaw);
        else await agents.turnOff(s.off);
        done += 1;
      }
      onDone();
    } catch {
      setFailed({ done, of: steps.length });
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

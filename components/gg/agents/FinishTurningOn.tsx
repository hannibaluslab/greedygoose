"use client";

import { TxError } from "../TxUi";
import { useAgents } from "@/hooks/useAgents";
import { useTx } from "@/hooks/useTx";
import { AGENTS_LIVE } from "@/lib/agents/config";
import type { AgentJob } from "@/lib/agents/permissions";

/** The Finish write's state: what its button waits on, and what stopped it. */
export type FinishState = { onFinish: () => void; busy: boolean; waiting: boolean; error: string | null };

/**
 * A grant JAW made that the executor doesn't run yet: one more Face ID, the batch that registers it (useAgents'
 * `finishPlan`, every waiting grant at once). In the sheet of the agent it belongs to, and in the Cash sheet for
 * earning and turning other dollars into cash, which have no agent of their own (D20).
 */
export function FinishBlock({
  finish,
  disabled = false,
  title = "One more Face ID turns it on.",
  sub = "Until then, it doesn’t run.",
}: {
  finish: FinishState;
  disabled?: boolean;
  title?: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[22px] bg-card px-4 py-3.5 shadow-card-elev">
      <p className="m-0 text-[15px] font-semibold">{title}</p>
      <p className="m-0 text-sm leading-[1.4] text-ink-2">{sub}</p>
      <button
        type="button"
        disabled={disabled || finish.busy || finish.waiting}
        aria-busy={finish.busy}
        onClick={finish.onFinish}
        className="mt-1 flex h-12 items-center justify-center rounded-full bg-ink text-[15px] font-semibold text-on-ink disabled:opacity-45"
      >
        {finish.busy ? "Finishing…" : "Finish turning it on"}
      </button>
      <TxError error={finish.error} />
    </div>
  );
}

/**
 * FinishBlock with its own write, for a screen that holds no agents (the Cash sheet): nothing while none of `jobs`
 * waits. `copy` words it for the jobs that do.
 */
export function FinishTurningOn({
  account,
  jobs,
  copy,
}: {
  account: `0x${string}`;
  jobs: readonly AgentJob[];
  copy: (waiting: AgentJob[]) => { title: string; sub: string };
}) {
  const agents = useAgents(account);
  const tx = useTx("This didn’t go through on Base. Try again to finish turning it on.", agents.finishPlan);
  const waiting = jobs.filter((j) => agents.toFinish.includes(j));
  if (!AGENTS_LIVE || waiting.length === 0) return null;
  const { title, sub } = copy(waiting);
  return (
    <FinishBlock
      title={title}
      sub={sub}
      finish={{ onFinish: () => void tx.sign(), busy: tx.busy, waiting: tx.checking || tx.blocked, error: tx.error }}
    />
  );
}

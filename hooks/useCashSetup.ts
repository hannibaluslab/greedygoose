"use client";

import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { useAgentRun } from "@/hooks/useAgentRun";
import { useAgents } from "@/hooks/useAgents";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { LIMIT_USD, limitRaw } from "@/lib/agents/permissions";

/** Why a grant can't be signed now; null when it can. */
const FEE_BLOCKED = "Your account can’t pay network fees in USDC on Base right now.";

/**
 * The two grants that run under the hood (D20), each one Face ID on JAW's own screen (D14): earning (the Save job) and
 * turning other dollars into cash on their own (the Entry job), each at its one limit (LIMIT_USD), never above the
 * executor's CAP_MAX. No agent, limit or switch is shown for them.
 */
export function useCashSetup(account: `0x${string}`) {
  const { address: signer } = useAccount();
  const fee = useFeeSupport();
  const agents = useAgents(account);
  const runner = useAgentRun(agents);
  const capMax = agents.capMaxRaw;

  const blocked = !!signer && fee.state === "unsupported" ? FEE_BLOCKED : capMax === null ? "One moment…" : null;
  const grant = (job: "save" | "entry", onDone: () => void) => {
    if (capMax === null) return;
    void runner.run([{ grant: { job, capRaw: limitRaw(LIMIT_USD[job].start, capMax) } }], onDone);
  };

  return {
    /** Earning: "unconfigured" with no executor, then off, starting or on. */
    save: agents.status.save,
    /** Other dollars converting on their own. */
    entry: agents.status.entry,
    blocked,
    /** The dev preview (`?as=`) reads another account: nothing can be signed for it. */
    preview: !signer || !isAddressEqual(signer, account),
    running: runner.running,
    error: runner.error,
    reset: runner.reset,
    /** "Finish setting up": your cash starts earning. */
    startEarning: (onDone: () => void) => grant("save", onDone),
    /** "Do this automatically next time?": other dollars turn into cash on their own. */
    convertAutomatically: (onDone: () => void) => grant("entry", onDone),
  };
}

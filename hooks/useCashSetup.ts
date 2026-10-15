"use client";

import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { useAgentRun } from "@/hooks/useAgentRun";
import { useAgents } from "@/hooks/useAgents";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { LIMIT_USD, limitRaw } from "@/lib/agents/permissions";

/** Why a grant can't be signed now; null when it can. */
const FEE_BLOCKED = "Your account can’t pay network fees in USDC on Base right now.";

/** A grant's button and what's around it: signing, its last error, why it can't be signed, and the dev preview. */
export type GrantView = { busy: boolean; error: string | null; blocked: string | null; preview: boolean };

/**
 * The two grants that run under the hood (D20), each one Face ID on JAW's own screen (D14): earning (the Save job) and
 * turning other dollars into cash on their own (the Entry job), each at its one limit (LIMIT_USD), never above the
 * executor's CAP_MAX. No agent, limit or switch is shown for them. Each has its own run, so a grant that didn't go
 * through is retried as itself and its error stays on its own button.
 */
export function useCashSetup(account: `0x${string}`) {
  const { address: signer } = useAccount();
  const fee = useFeeSupport();
  const agents = useAgents(account);
  const earning = useAgentRun(agents);
  const automatic = useAgentRun(agents);
  const capMax = agents.capMaxRaw;

  const feeBlocked = !!signer && fee.state === "unsupported" ? FEE_BLOCKED : null;
  const blocked = feeBlocked ?? (capMax === null ? "One moment…" : null);
  // The dev preview (`?as=`) reads another account: nothing can be signed for it.
  const preview = !signer || !isAddressEqual(signer, account);
  const view = (run: ReturnType<typeof useAgentRun>): GrantView => ({ busy: run.running, error: run.errorFor(""), blocked, preview });
  /** `prior`: JAW sheets of the same tap that went through before this grant (Start earning's batch). */
  const grant = (run: ReturnType<typeof useAgentRun>, job: "save" | "entry", onDone: () => void, prior = 0): Promise<string | null> => {
    if (capMax === null) return Promise.resolve("One moment…");
    return run.run(job, [{ grant: { job, capRaw: limitRaw(LIMIT_USD[job].start, capMax) } }], onDone, prior);
  };

  return {
    /** Earning: "unconfigured" with no executor, then off, starting or on. */
    save: agents.status.save,
    /** Other dollars converting on their own. */
    entry: agents.status.entry,
    /** The executor's registry couldn't be read, so whether earning is set up isn't known yet. */
    unreadable: agents.unreadable,
    preview,
    /** Why nothing can be signed now: the account can't pay network fees in USDC (D4). Null when it can. */
    feeBlocked,
    /**
     * Earning's grant (the Save job): Start earning's second JAW sheet, after its batch (useStartEarning). Resolves to
     * the error it shows, or null once it went through.
     */
    earning: view(earning),
    grantSave: (onDone: () => void, prior = 0) => grant(earning, "save", onDone, prior),
    /** "Do this automatically next time?": other dollars turn into cash on their own. */
    automatic: view(automatic),
    convertAutomatically: (onDone: () => void) => void grant(automatic, "entry", onDone),
    /** Clears the last "automatically" error, for a new conversion. */
    resetAutomatic: automatic.reset,
  };
}

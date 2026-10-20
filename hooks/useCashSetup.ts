"use client";

import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { useAgents } from "@/hooks/useAgents";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { TxPlan } from "@/hooks/useTx";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { LIMIT_USD, limitRaw } from "@/lib/agents/permissions";
import type { ChangePrefix } from "@/lib/tx/plans";

/** The cap each grant carries: Save at CAP_MAX (P2, no amount limit), Entry at its one limit, never above CAP_MAX. */
const capOf = (job: "save" | "entry", capMax: bigint) =>
  job === "save" ? capMax : limitRaw(LIMIT_USD.entry.start, capMax);

/** Why a grant can't be signed now; null when it can. */
const FEE_BLOCKED = "Your account can’t pay network fees from your cash right now.";

/**
 * The two grants that run under the hood (D20): earning (the Save job), at the executor's CAP_MAX with no amount limit
 * (P2, Adrian 2026-10-20), and turning other dollars into cash on their own (the Entry job), at its one limit
 * (LIMIT_USD), never above CAP_MAX. Each is one batch, one Face ID
 * (useAgents `changePlan`, Adrian 2026-10-20). No agent, limit or switch is shown for them. Earning rides in Start
 * earning's batch (useStartEarning, `earningPlan`), and converting automatically in Turn into cash's (`automaticPlan`,
 * Adrian 2026-10-20: "turn into cash means next time automatically").
 */
export function useCashSetup(account: `0x${string}`) {
  const { address: signer } = useAccount();
  const fee = useFeeSupport();
  const agents = useAgents(account);
  const capMax = agents.capMaxRaw;

  const feeBlocked = !!signer && fee.state === "unsupported" ? FEE_BLOCKED : null;
  // Never before the agents are live: the screens don't offer it, and this holds if one ever did.
  const blocked = !AGENTS_LIVE ? "Coming soon." : (feeBlocked ?? (capMax === null ? "One moment…" : null));
  // The dev preview (`?as=`) reads another account: nothing can be signed for it.
  const preview = !signer || !isAddressEqual(signer, account);

  /** A job's grant in one batch, after `prefix` when there is one; null while it can't be signed. */
  const grantPlan = (job: "save" | "entry", prefix?: ChangePrefix): TxPlan | null =>
    !AGENTS_LIVE || capMax === null
      ? null
      : agents.changePlan({ grants: [{ job, capRaw: capOf(job, capMax) }], prefix });

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
    /** Why earning's grant can't be signed now (not live, the fee, CAP_MAX still loading); null when it can. */
    earningBlocked: blocked,
    /** Earning's grant (the Save job) in one batch, after `prefix` (Start earning's supply); null while it can't be. */
    earningPlan: (prefix?: ChangePrefix) => grantPlan("save", prefix),
    /**
     * Converting automatically (the Entry job) in one batch after `prefix` (Turn into cash's conversion); null while it
     * can't be signed.
     */
    automaticPlan: (prefix: ChangePrefix) => grantPlan("entry", prefix),
  };
}

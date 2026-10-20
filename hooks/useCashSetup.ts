"use client";

import { useEffect, useRef } from "react";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { useAgents } from "@/hooks/useAgents";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useTx, type TxPhase, type TxPlan } from "@/hooks/useTx";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { LIMIT_USD, limitRaw } from "@/lib/agents/permissions";
import { formatUsdTrim } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";
import type { ChangePrefix } from "@/lib/tx/plans";

/** The cap each grant carries: Save at CAP_MAX (P2, no amount limit), Entry at its one limit, never above CAP_MAX. */
const capOf = (job: "save" | "entry", capMax: bigint) =>
  job === "save" ? capMax : limitRaw(LIMIT_USD.entry.start, capMax);

/** Why a grant can't be signed now; null when it can. */
const FEE_BLOCKED = "Your account can’t pay network fees from your cash right now.";

/**
 * A grant's button and what's around it: its write's phase, its last error, why it can't be signed, whether its batch
 * is still being prepared, and the dev preview.
 */
export type GrantView = {
  phase: TxPhase;
  busy: boolean;
  checking: boolean;
  error: string | null;
  blocked: string | null;
  preview: boolean;
};

/**
 * The two grants that run under the hood (D20): earning (the Save job), at the executor's CAP_MAX with no amount limit
 * (P2, Adrian 2026-10-20), and turning other dollars into cash on their own (the Entry job), at its one limit
 * (LIMIT_USD), never above CAP_MAX. Each is one batch, one Face ID
 * (useAgents `changePlan`, Adrian 2026-10-20). No agent, limit or switch is shown for them. Earning rides in Start
 * earning's own batch (useStartEarning, `earningPlan`); "convert automatically" is its own write, prepared while its
 * question shows (`automatic.prep` with `automatic.plan`).
 */
export function useCashSetup(account: `0x${string}`) {
  const { address: signer } = useAccount();
  const fee = useFeeSupport();
  const agents = useAgents(account);
  const capMax = agents.capMaxRaw;
  const automatic = useTx("This didn’t go through on Base. Nothing changed. Try again.");

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

  // "Convert automatically" landed: its caller hears once, and the write goes back to idle.
  const onAutomatic = useRef<(() => void) | null>(null);
  const resetAutomatic = automatic.reset;
  useEffect(() => {
    if (automatic.phase !== "done" || !onAutomatic.current) return;
    const done = onAutomatic.current;
    onAutomatic.current = null;
    done();
    resetAutomatic();
  }, [automatic.phase, resetAutomatic]);
  const automaticPlan = grantPlan("entry");
  /** "$1,000": Entry's daily limit as its grant carries it (a D13 test deploy holds it to CAP_MAX). */
  const entryLimitText = formatUsdTrim(
    Number(limitRaw(LIMIT_USD.entry.start, capMax ?? 2n ** 160n)) / 10 ** USDC.decimals,
  );

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
    /** Entry's daily limit, as the line before its Face ID says it (Save has none). */
    entryLimitText,
    /** "Do this automatically next time?": other dollars turn into cash on their own. */
    automatic: {
      view: {
        phase: automatic.phase,
        busy: automatic.busy,
        checking: automatic.checking,
        error: automatic.error,
        blocked,
        preview,
      } satisfies GrantView,
      plan: automaticPlan,
      /** For the question's body: `usePrepare(prep, plan)` while it shows. */
      prep: automatic.prep,
    },
    convertAutomatically: (onDone: () => void) => {
      if (!automaticPlan) return;
      onAutomatic.current = onDone;
      if (automatic.phase === "failed") automatic.reset();
      void automatic.sign(automaticPlan);
    },
    /** Clears the last "automatically" error, for a new conversion. */
    resetAutomatic,
  };
}

"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useBytecode, usePublicClient } from "wagmi";
import type { useCashSetup } from "@/hooks/useCashSetup";
import { usePrepare, useTx } from "@/hooks/useTx";
import { toUsd, type Cash } from "@/lib/cash";
import { readCash } from "@/lib/cash/read";
import { CHAIN_ID } from "@/lib/chain";
import { AGENTS_LIVE } from "@/lib/agents/config";
import {
  earningAllowsText,
  saveGrantFollows,
  startedEarningText,
  startEarningShown,
  startEarningSteps,
  startEarningText,
} from "@/lib/cashSetup";
import { startEarningFlow, startEarningPlan, startEarningPrefix, type StartEarningStage } from "@/lib/startEarning";

/** What the card said at the tap, and whether the Save grant follows on its own: kept while JAW's sheets are open. */
type Held = { title: string; line: string; steps: number; walletRaw: bigint; grant: boolean };

/**
 * Home's Start earning (Adrian, 2026-10-15): one tap moves the wallet's idle USDC into savings in one user-signed batch
 * (lib/startEarning.ts), prepared while the card shows so the tap opens JAW's sheet at once (useTx). With an executor
 * and no Save grant, earning's grant rides in the same batch, one Face ID (Adrian, 2026-10-20: "the permission, the
 * cash move and the registration in one signature"). An account JAW hasn't deployed yet can't have its registration
 * simulated, so there the grant is its own batch right after ("2 steps"); where JAW opens a popup only inside a tap
 * (Safari), that second sheet can't open by itself: "1 of 2 went through. Tap again to open JAW.", and the next tap
 * opens it. Once it's all through: "Your cash is earning 3.9%", and the card goes once the wallet is read again.
 */
export function useStartEarning(p: {
  account: `0x${string}`;
  /** The cash as usePosition read it; undefined while it loads. */
  cash: Cash | undefined;
  savingsUsd: number;
  setup: ReturnType<typeof useCashSetup>;
  /** The cash rate as the screens say it ("3.9%"), null while it loads. */
  rate: string | null;
}) {
  const { account, cash, setup, rate } = p;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const code = useBytecode({ address: account, chainId: CHAIN_ID });
  const tx = useTx("This didn’t go through on Base. Your cash didn’t move, except any network fee.");
  // Earning's grant on its own, after a batch that deployed the account.
  const grantTx = useTx("This didn’t go through on Base. Try again to start earning on new cash.");
  const [held, setHeld] = useState<Held | null>(null);
  const [stage, setStage] = useState<StartEarningStage | null>(null);
  // The grant after a landed batch starts once; the toast is said once.
  const launched = useRef(false);

  // The grant on its own (from the landed batch, or a later tap) landed: all through; it stopped (cancelled, or a sheet
  // JAW couldn't open): only it is left, and the next tap opens it.
  const grantFollows = held ? held.grant : null;
  const asked = startEarningFlow({ stage, phase: tx.phase, busy: tx.busy, grantFollows }).granting;
  const grantDone = asked && grantTx.phase === "done";
  const grantStopped = asked && (grantTx.phase === "failed" || (grantTx.phase === "idle" && !!grantTx.error));
  const current: StartEarningStage | null = grantDone ? "landed" : grantStopped ? "grant-left" : stage;
  const { deposited, granting, landed, pinned, phase } = startEarningFlow({
    stage: current,
    phase: tx.phase,
    busy: tx.busy,
    grantFollows,
  });
  // Done, and Home read the wallet again (the batch moved it): the card follows the rule again, for new money.
  if (landed && held && cash && cash.walletRaw !== held.walletRaw) {
    setStage(null);
    setHeld(null);
  }

  const shown = !!cash && startEarningShown(setup.save, cash.walletRaw);
  const visible = pinned || (!landed && shown);
  const words =
    pinned && held
      ? held
      : cash
        ? startEarningText({ walletUsd: toUsd(cash.walletRaw), savingsUsd: p.savingsUsd, rate })
        : null;
  // Earning is granted only once the agents are live (SPEC: "Coming soon" stands where Save is).
  const grants = saveGrantFollows(setup.save, AGENTS_LIVE);
  const deployed = !!code.data && code.data !== "0x";
  const together = grants && deployed;
  const steps = pinned && held ? held.steps : startEarningSteps(setup.save, AGENTS_LIVE, deployed);
  // Its batch reads the wallet again while it's prepared (readCash), as every flow that spends cash does. Nothing to
  // prepare mid-tap, or before the account's code is read (it decides whether the grant rides along).
  const readWallet = async (user: `0x${string}`) => (await readCash(client!, user)).walletRaw;
  const supply =
    visible && !pinned && cash && code.isFetched ? startEarningPlan(account, cash.walletRaw, readWallet) : null;
  const plan = supply && (together ? setup.earningPlan(startEarningPrefix(supply)) : supply);
  // Prepared while the card waits (useTx's store), so the tap opens JAW's sheet with nothing awaited first.
  const prep = usePrepare(tx.prep, plan);
  // The grant alone, once it's the step left: prepared then, so a second tap opens it at once.
  const grantPlan = asked || current === "grant-left" ? setup.earningPlan() : null;
  const grantPrep = usePrepare(grantTx.prep, grantPlan);

  const live = useRef({ setup, rate, grantPlan, resetTx: tx.reset });
  useEffect(() => {
    live.current = { setup, rate, grantPlan, resetTx: tx.reset };
  });
  const said = () => toast.success(startedEarningText(live.current.rate));

  // The grant on its own landed: said once.
  const grantSaid = useRef(false);
  useEffect(() => {
    if (!grantDone || grantSaid.current) return;
    grantSaid.current = true;
    said();
  }, [grantDone]);

  // The batch landed: earning's grant on its own when one follows, once (it shows as granting from here); else it's
  // done, and says so.
  useEffect(() => {
    if (!deposited || launched.current) return;
    launched.current = true;
    if (held?.grant) {
      grantSaid.current = false;
      grantTx.reset();
      void grantTx.sign(live.current.setup.earningPlan());
    } else said();
    // said and the grant's plan read the latest setup and rate from `live`; grantTx's calls are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposited, held]);

  // Cleared after it landed: the write goes back to idle, so new money's batch is prepared again.
  useEffect(() => {
    if (stage === null && !held && tx.phase === "done") live.current.resetTx();
  }, [stage, held, tx.phase]);

  function start() {
    // The batch landed and only the grant is left: this tap opens JAW's sheet for it, prepared, nothing awaited first.
    if (current === "grant-left") {
      setStage("grant");
      grantSaid.current = false;
      void grantTx.sign(grantPlan);
      return;
    }
    if (!plan || !cash || !words) return;
    if (tx.phase === "failed") tx.reset();
    grantTx.reset();
    launched.current = false;
    setHeld({ title: words.title, line: words.line, steps, walletRaw: cash.walletRaw, grant: grants && !together });
    setStage("deposit");
    void tx.sign(plan);
  }

  // With a grant, it needs the executor's limit read too ("One moment…"); the batch alone, only the fee.
  const left = current === "grant-left";
  const note = grants || left ? setup.earningBlocked : setup.feeBlocked;
  const { title, line } = words ?? { title: "", line: "" };
  // The grant's own error once only it is left; none while it's on JAW's sheet; else the batch's, or its preparing's.
  const error = left
    ? grantTx.error
      ? `1 of 2 went through. ${grantTx.error}`
      : grantPrep.error
    : granting
      ? null
      : (tx.error ?? (plan ? prep.error : null));
  return {
    visible,
    title,
    line,
    steps,
    /** What its Face ID lets the app do when it grants earning; null when it doesn't. */
    allows: grants ? earningAllowsText(setup.limitText("save")) : null,
    phase,
    checking: left ? grantPrep.checking : plan ? prep.checking : false,
    blocked: left ? grantPrep.blocked : plan ? prep.blocked : false,
    error,
    note,
    preview: setup.preview,
    start,
  };
}

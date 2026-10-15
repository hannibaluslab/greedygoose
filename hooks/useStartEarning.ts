"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { useCashSetup } from "@/hooks/useCashSetup";
import { usePrepare, useTx, type TxPhase } from "@/hooks/useTx";
import { toUsd, type Cash } from "@/lib/cash";
import { startedEarningText, startEarningShown, startEarningSteps, startEarningText } from "@/lib/cashSetup";
import { startEarningPlan } from "@/lib/startEarning";

/** What the card said at the tap, and whether the Save grant follows: kept while JAW's sheets are open. */
type Held = { title: string; line: string; steps: number; walletRaw: bigint; grant: boolean };

/**
 * Where a tap is, as far as it isn't read off the batch itself (useTx's phase): its batch on JAW's sheet or confirming,
 * then, once it lands, the Save grant when one follows ("deposit"); the grant still to open ("grant-left": JAW couldn't
 * open it, or it was cancelled), or opened again from a tap ("grant"); all through ("landed") until Home reads the
 * wallet again.
 */
type Stage = "deposit" | "grant" | "grant-left" | "landed";

/**
 * Home's Start earning (Adrian, 2026-10-15): one tap moves the wallet's idle USDC into savings in one user-signed batch
 * (lib/startEarning.ts), prepared while the card shows so the tap opens JAW's sheet at once (useTx). With an executor
 * and no Save grant, the same tap goes on to JAW's own screen for the grant once the batch lands (D14: a grant can't
 * ride in a batch), and the button says "2 steps". Where JAW opens a popup only inside a tap (Safari), that second
 * screen can't open by itself: "1 of 2 went through. Tap again to open JAW.", and the next tap opens the grant alone.
 * Once it's all through: "Your cash is earning 3.9%", and the card goes once the wallet is read again.
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
  const tx = useTx("This didn’t go through on Base. Your cash didn’t move, except any network fee.");
  const [held, setHeld] = useState<Held | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  // The grant after a landed batch starts once; the toast is said once.
  const launched = useRef(false);
  const live = useRef({ setup, rate, resetTx: tx.reset });
  useEffect(() => {
    live.current = { setup, rate, resetTx: tx.reset };
  });

  const deposited = stage === "deposit" && tx.phase === "done" && !!held;
  // The batch landed and the Save grant follows, on JAW's own screen: from the effect below, or again from a tap.
  const granting = (deposited && held.grant) || stage === "grant";
  const landed = stage === "landed" || (deposited && !held.grant);
  // Done, and Home read the wallet again (the batch moved it): the card follows the rule again, for new money.
  if (landed && held && cash && cash.walletRaw !== held.walletRaw) {
    setStage(null);
    setHeld(null);
  }

  const shown = !!cash && startEarningShown(setup.save, cash.walletRaw);
  // Mid-tap the card stays as it was signed for, so it doesn't change under the user as balances re-read.
  const pinned = granting || stage === "grant-left" || (stage === "deposit" && tx.busy);
  const visible = pinned || (!landed && shown);
  const words = pinned && held ? held : cash ? startEarningText({ walletUsd: toUsd(cash.walletRaw), savingsUsd: p.savingsUsd, rate }) : null;
  const steps = pinned && held ? held.steps : startEarningSteps(setup.save);
  // Nothing to prepare mid-tap: the batch is on JAW's sheet or landed, or only the grant is left.
  const plan = visible && !pinned && cash ? startEarningPlan(account, cash.walletRaw) : null;
  // Prepared while the card waits (useTx's store), so the tap opens JAW's sheet with nothing awaited first.
  const prep = usePrepare(tx.prep, plan);

  const said = () => toast.success(startedEarningText(live.current.rate));
  /** The Save grant on JAW's screen; `prior`: the batch went through first, so a stop reads "1 of 2 went through". */
  const grantSave = () =>
    live.current.setup.grantSave(said, 1).then((stopped) => setStage(stopped === null ? "landed" : "grant-left"));

  // The batch landed: the Save grant when one was asked for, once; else it's done, and says so.
  useEffect(() => {
    if (!deposited || launched.current) return;
    launched.current = true;
    if (held?.grant) void grantSave();
    else said();
    // grantSave and said read the latest setup and rate from `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposited, held]);

  // Cleared after it landed: the write goes back to idle, so new money's batch is prepared again.
  useEffect(() => {
    if (stage === null && !held && tx.phase === "done") live.current.resetTx();
  }, [stage, held, tx.phase]);

  function start() {
    // The batch landed and only the grant is left: this tap opens JAW's screen for it, with nothing awaited first.
    if (stage === "grant-left") {
      setStage("grant");
      void grantSave();
      return;
    }
    if (!plan || !cash || !words) return;
    if (tx.phase === "failed") tx.reset();
    launched.current = false;
    setHeld({ title: words.title, line: words.line, steps, walletRaw: cash.walletRaw, grant: setup.save === "off" });
    setStage("deposit");
    void tx.sign(plan);
  }

  const phase: TxPhase = granting ? "signing" : stage === "deposit" ? tx.phase : stage === "grant-left" || landed ? "idle" : tx.phase;
  // With a grant to follow, it needs the executor's limit read too ("One moment…"); the batch alone, only the fee.
  const blocked = setup.save === "off" || stage === "grant-left" ? setup.earning.blocked : setup.feeBlocked;
  return {
    visible,
    title: words?.title ?? "",
    line: words?.line ?? "",
    steps,
    phase,
    checking: plan ? prep.checking : false,
    blocked: plan ? prep.blocked : false,
    error: stage === "grant-left" ? setup.earning.error : granting ? null : (tx.error ?? (plan ? prep.error : null)),
    note: blocked,
    preview: setup.preview,
    start,
  };
}

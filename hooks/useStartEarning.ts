"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { usePublicClient } from "wagmi";
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
  startEarningText,
} from "@/lib/cashSetup";
import { startEarningFlow, startEarningPlan, startEarningPrefix, type StartEarningStage } from "@/lib/startEarning";

/** What the card said at the tap: kept while JAW's sheet is open, so it doesn't change under the user. */
type Held = { title: string; line: string; walletRaw: bigint };

/**
 * Home's Start earning (Adrian, 2026-10-15): one tap moves the wallet's idle USDC into savings in one user-signed batch
 * (lib/startEarning.ts), prepared while the card shows so the tap opens JAW's sheet at once (useTx). With an executor
 * and no Save grant, earning's grant rides in the same batch: one Face ID, an account JAW hasn't deployed yet included
 * (Adrian, 2026-10-20; how its registration is checked: lib/tx/plans/agents.ts). Once it's through: "Your cash is
 * earning 3.9%", and the card goes once the wallet is read again.
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
  const tx = useTx("This didn’t go through on Base. Your cash didn’t move, except any network fee.");
  const [held, setHeld] = useState<Held | null>(null);
  const [stage, setStage] = useState<StartEarningStage | null>(null);
  // The toast is said once a tap's batch lands, read off the write: the card's state goes the moment Home reads the
  // wallet again, maybe in the same render.
  const tapped = useRef(false);

  const { landed, pinned, phase } = startEarningFlow({
    stage,
    phase: tx.phase,
    busy: tx.busy,
    grantFollows: held ? false : null,
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
  // Its batch reads the wallet again while it's prepared (readCash), as every flow that spends cash does.
  const readWallet = async (user: `0x${string}`) => (await readCash(client!, user)).walletRaw;
  const supply = visible && !pinned && cash ? startEarningPlan(account, cash.walletRaw, readWallet) : null;
  const plan = supply && (grants ? setup.earningPlan(startEarningPrefix(supply)) : supply);
  // Prepared while the card waits (useTx's store), so the tap opens JAW's sheet with nothing awaited first.
  const prep = usePrepare(tx.prep, plan);

  const live = useRef({ rate, resetTx: tx.reset });
  useEffect(() => {
    live.current = { rate, resetTx: tx.reset };
  });

  // The batch landed: said once.
  useEffect(() => {
    if (tx.phase !== "done" || !tapped.current) return;
    tapped.current = false;
    toast.success(startedEarningText(live.current.rate));
  }, [tx.phase]);

  // Cleared after it landed: the write goes back to idle, so new money's batch is prepared again.
  useEffect(() => {
    if (stage === null && !held && tx.phase === "done") live.current.resetTx();
  }, [stage, held, tx.phase]);

  function start() {
    if (!plan || !cash || !words) return;
    if (tx.phase === "failed") tx.reset();
    tapped.current = true;
    setHeld({ title: words.title, line: words.line, walletRaw: cash.walletRaw });
    setStage("deposit");
    void tx.sign(plan);
  }

  // With a grant, it needs the executor's limit read too ("One moment…"); the batch alone, only the fee.
  const note = grants ? setup.earningBlocked : setup.feeBlocked;
  const { title, line } = words ?? { title: "", line: "" };
  return {
    visible,
    title,
    line,
    /** What its Face ID lets the app do when it grants earning; null when it doesn't. */
    allows: grants ? earningAllowsText() : null,
    phase,
    // A batch that grants earning waits for what it's built from (the executor's registry): checking until then.
    checking: plan ? prep.checking : !!supply,
    blocked: plan ? prep.blocked : false,
    error: tx.error ?? (plan ? prep.error : null),
    note,
    preview: setup.preview,
    start,
  };
}

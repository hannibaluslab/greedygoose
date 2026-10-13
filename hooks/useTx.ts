"use client";

import { useEffect, useState } from "react";
import { usePublicClient, useSendCalls, useWaitForCallsStatus } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { CHAIN_ID } from "@/lib/chain";
import { explainRevert } from "@/lib/aave/errors";
import type { Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { addLocal, updateLocal } from "@/lib/activity/local";

export type TxPhase = "idle" | "simulating" | "signing" | "pending" | "done" | "failed";

/**
 * The one write path (CLAUDE.md › Transaction safety):
 * simulate the whole batch from the user → JAW signs once (wallet_sendCalls) → wait → re-read chain state.
 * No optimistic state: "done" only after the batch lands.
 */
export function useTx(failedOnChain = "This didn’t go through on Base. Nothing moved except any network fee.") {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const send = useSendCalls();
  const status = useWaitForCallsStatus({ id: send.data?.id, query: { enabled: !!send.data?.id } });
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<{ user: `0x${string}`; id: string } | null>(null);

  const callsStatus = status.data?.status;
  const effective: TxPhase =
    phase === "pending" && callsStatus === "success" ? "done" : phase === "pending" && callsStatus === "failure" ? "failed" : phase;
  const shownError = effective === "failed" && phase === "pending" ? failedOnChain : error;

  const txHash = status.data?.receipts?.at(-1)?.transactionHash;
  useEffect(() => {
    if (callsStatus === "success") void queryClient.invalidateQueries();
    if (record && (callsStatus === "success" || callsStatus === "failure")) {
      updateLocal(record.user, record.id, { status: callsStatus === "success" ? "done" : "failed", hash: txHash });
    }
  }, [callsStatus, queryClient, record, txHash]);

  async function run(
    user: `0x${string}`,
    calls: Call[],
    fallback = "This would fail right now. Try again in a moment.",
    activity?: ActivityItem[],
  ) {
    setError(null);
    setPhase("simulating");
    try {
      const sim = await client!.simulateCalls({ account: user, calls: calls.map(({ to, data }) => ({ to, data })) });
      const bad = sim.results.find((r) => r.status !== "success");
      if (bad) {
        setPhase("failed");
        setError(explainRevert(bad.data, fallback));
        return;
      }
    } catch {
      setPhase("failed");
      setError("We couldn’t check this with Base. Please try again.");
      return;
    }
    setPhase("signing");
    try {
      const sent = await send.mutateAsync({ chainId: CHAIN_ID, calls: calls.map(({ to, data }) => ({ to, data })) });
      if (activity) {
        addLocal(user, { id: sent.id, time: Date.now(), items: activity, status: "pending" });
        setRecord({ user, id: sent.id });
      }
      setPhase("pending");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setPhase("failed");
      setError(/reject|denied|cancel/i.test(msg) ? "You cancelled. Nothing was sent." : "We couldn’t send this. Please try again.");
    }
  }

  const reset = () => {
    setPhase("idle");
    setError(null);
    send.reset();
  };

  const busy = effective === "simulating" || effective === "signing" || effective === "pending";
  return { run, phase: effective, error: shownError, reset, busy, txHash };
}

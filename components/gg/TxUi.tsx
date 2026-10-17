"use client";

import type { ReactNode } from "react";
import { txUrl } from "@/lib/chain";
import { TAP_AGAIN, type TxPhase } from "@/lib/tx/prepared";
import { stepsNote } from "@/lib/formatting";
import { buttonClass, type ButtonSize } from "./Button";

/**
 * The one button that opens JAW's own sheet (its Review and Face ID), lime, named for the action only: "Buy", "Repay",
 * "Switch on". The screen it sits on already says what matters, so there is no confirm step of ours before it, and
 * while JAW's sheet is open this screen adds nothing: the label stays and the button waits. lg at the foot of a page,
 * md in a sheet. Under it, one small line: `note` (why it can't go ahead), else "2 steps" when one tap opens JAW's
 * sheet more than once (`steps`). `checking`: the batch for what's on screen is still being prepared (useTx), so the
 * button says "Checking…" and waits; once it's ready the tap opens JAW's sheet with nothing in between.
 */
export function TxButton({
  label,
  phase,
  checking = false,
  steps = 1,
  note,
  disabled,
  onClick,
  preview,
  size = "lg",
}: {
  label: string;
  phase: TxPhase;
  checking?: boolean;
  steps?: number;
  note?: string | null;
  disabled?: boolean;
  onClick: () => void;
  preview?: boolean;
  size?: ButtonSize;
}) {
  const busy = phase === "simulating" || phase === "signing" || phase === "pending";
  const waiting = checking && !busy && phase !== "done";
  const text = phase === "simulating" || waiting ? "Checking…" : phase === "pending" ? "Confirming on Base…" : label;
  // "done" too: a sheet that closes on success (BuySheet) still shows the button while it slides out.
  const off = disabled || preview || busy || waiting || phase === "done";
  const line = note ?? stepsNote(steps);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={off}
        onClick={onClick}
        aria-busy={busy || waiting}
        data-tx={waiting ? "checking" : busy ? phase : undefined}
        className={buttonClass("primary", size)}
      >
        {text}
      </button>
      {preview ? (
        <p className="m-0 text-center text-xs text-subtle">Preview mode — sign in to do this.</p>
      ) : (
        line && <p className="m-0 text-center text-xs text-subtle">{line}</p>
      )}
    </div>
  );
}

/** The write's error under its screen. "Tap again to open JAW." isn't an error, so it reads as a plain line. */
export function TxError({ error }: { error: string | null }) {
  if (!error) return null;
  if (error.endsWith(TAP_AGAIN))
    return (
      <p role="status" className="m-0 text-[13px] font-medium leading-snug text-ink">
        {error}
      </p>
    );
  return (
    <p role="alert" className="m-0 text-[13px] leading-snug text-act">
      {error}
    </p>
  );
}

export function TxDone({
  title,
  body,
  txHash,
  onDone,
  doneLabel = "Done",
}: {
  title: string;
  body: ReactNode;
  txHash?: `0x${string}`;
  onDone: () => void;
  doneLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 pt-2" role="status">
      <span aria-hidden className="flex size-12 items-center justify-center rounded-3xl bg-brand">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0e0d0b"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12l5 5 9-10" />
        </svg>
      </span>
      <h2 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{title}</h2>
      <p className="m-0 text-[15px] text-ink-mid">{body}</p>
      {txHash && (
        <a href={txUrl(txHash)} target="_blank" rel="noreferrer" className="text-[13px] text-ink-mid underline">
          View on Base explorer
        </a>
      )}
      <button type="button" onClick={onDone} className={`mt-2 ${buttonClass("dark", "md")}`}>
        {doneLabel}
      </button>
    </div>
  );
}

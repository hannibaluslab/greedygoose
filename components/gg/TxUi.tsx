"use client";

import type { ReactNode } from "react";
import { txUrl } from "@/lib/chain";
import type { TxPhase } from "@/hooks/useTx";
import { buttonClass, type ButtonSize } from "./Button";

const FaceId = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1M15 9v1M12 9v4h-1M9 16c1.5 1 4.5 1 6 0" />
  </svg>
);

/** Lime Face ID CTA whose label follows the transaction phase. lg at the foot of a page (CreditOn), md in a sheet (F2-6). */
export function FaceIdButton({
  label, phase, disabled, onClick, preview, size = "lg",
}: { label: string; phase: TxPhase; disabled?: boolean; onClick: () => void; preview?: boolean; size?: ButtonSize }) {
  const text =
    phase === "simulating" ? "Checking…" : phase === "signing" ? "Confirm with Face ID…" : phase === "pending" ? "Confirming on Base…" : label;
  const off = disabled || preview || phase === "simulating" || phase === "signing" || phase === "pending";
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={off}
        onClick={onClick}
        aria-busy={phase === "simulating" || phase === "signing" || phase === "pending"}
        className={buttonClass("primary", size)}
      >
        <FaceId />
        {text}
      </button>
      {preview && <p className="m-0 text-center text-xs text-subtle">Preview mode — sign in to do this.</p>}
    </div>
  );
}

export function TxError({ error }: { error: string | null }) {
  return error ? <p role="alert" className="m-0 text-[13px] leading-snug text-act">{error}</p> : null;
}

export function TxDone({ title, body, txHash, onDone, doneLabel = "Done" }: { title: string; body: ReactNode; txHash?: `0x${string}`; onDone: () => void; doneLabel?: string }) {
  return (
    <div className="flex flex-col gap-3 pt-2" role="status">
      <span aria-hidden className="flex size-12 items-center justify-center rounded-3xl bg-brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0e0d0b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
      </span>
      <h2 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{title}</h2>
      <p className="m-0 text-[15px] text-ink-mid">{body}</p>
      {txHash && <a href={txUrl(txHash)} target="_blank" rel="noreferrer" className="text-[13px] text-ink-mid underline">View on Base explorer</a>}
      <button type="button" onClick={onDone} className={`mt-2 ${buttonClass("dark", "md")}`}>{doneLabel}</button>
    </div>
  );
}

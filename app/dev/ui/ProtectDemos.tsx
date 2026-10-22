"use client";

import { toast } from "sonner";
import { ProtectSettingsView, type ProtectSettingsViewProps } from "@/components/gg/agents/ProtectSettings";
import { sellLimitsFor, type ProtectSaved } from "@/lib/agents/protect";

// Sample figures for the gallery only: NVIDIA backs $2,000 and Tesla $1,400 of credit (HoldingCards' figures), at
// Aave-like prices. Nothing here reads the chain.
const BACKS = [0, 0, 0, 0, 0, 2_000, 1_400];
const TESLA = 6;

/** Protect's grants have no amount limit (decision 9). */
const SAVED: Record<"off" | "on" | "repay", ProtectSaved> = {
  off: { repayOn: false, sell: null, keepMix: null },
  on: { repayOn: true, sell: { limitsRaw: sellLimitsFor([TESLA]) }, keepMix: false },
  repay: { repayOn: true, sell: null, keepMix: false },
};

/**
 * Protect's settings body in each state the sheet shows: not live yet, off (saving switches it on), all on, selling
 * off. Saving only toasts.
 */
export function ProtectDemo({ state }: { state: "not-live" | "off" | "on" | "sell-off" }) {
  const props: ProtectSettingsViewProps = {
    live: state !== "not-live",
    preview: false,
    saved: state === "not-live" || state === "off" ? SAVED.off : state === "on" ? SAVED.on : SAVED.repay,
    backsUsd: BACKS,
    feeBlocked: false,
    phase: "idle",
    error: null,
    busy: false,
    onSave: (steps) => toast(`Would save ${steps.length} change${steps.length === 1 ? "" : "s"}`),
  };
  return <ProtectSettingsView {...props} />;
}

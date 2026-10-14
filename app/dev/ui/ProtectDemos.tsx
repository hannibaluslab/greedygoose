"use client";

import { toast } from "sonner";
import { ProtectSettingsView, type ProtectSettingsViewProps } from "@/components/gg/agents/ProtectSettings";
import { sellLimitsFor, type ProtectSaved } from "@/lib/agents/protect";

// Sample figures for the gallery only: NVIDIA backs $2,000 and Tesla $1,400 of credit (HoldingCards' figures), at
// Aave-like prices. Nothing here reads the chain.
const usdc = (x: number) => BigInt(x) * 10n ** 6n;
const PRICES = [250, 220, 180, 700, 500, 180, 383].map((p) => BigInt(p) * 10n ** 8n);
const BACKS = [0, 0, 0, 0, 0, 2_000, 1_400];
const CAP_MAX = usdc(10_000);
const TESLA = 6;

const SAVED: Record<"off" | "on" | "repay", ProtectSaved> = {
  off: { repayCapRaw: null, sell: null, keepMix: null },
  on: { repayCapRaw: usdc(300), sell: { capRaw: usdc(300), limitsRaw: sellLimitsFor(usdc(300), CAP_MAX, PRICES, [TESLA]) }, keepMix: false },
  repay: { repayCapRaw: usdc(300), sell: null, keepMix: false },
};

/** Protect's settings body in each state the sheet shows: not live yet, all on, selling off. Saving only toasts. */
export function ProtectDemo({ state }: { state: "not-live" | "on" | "sell-off" }) {
  const props: ProtectSettingsViewProps = {
    live: state !== "not-live",
    preview: false,
    saved: state === "not-live" ? SAVED.off : state === "on" ? SAVED.on : SAVED.repay,
    backsUsd: BACKS,
    pricesRaw: PRICES,
    capMaxRaw: state === "not-live" ? null : CAP_MAX,
    sellGrants: state === "on" ? 1 : 0,
    feeBlocked: false,
    phase: "idle",
    error: null,
    busy: false,
    onSave: (steps) => toast(`Would save ${steps.length} change${steps.length === 1 ? "" : "s"}`),
  };
  return <ProtectSettingsView {...props} />;
}

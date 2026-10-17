import { RISK, type RiskBands } from "@/config/risk";

export type Status = "none" | "safe" | "watch" | "act";

/** `healthFactor` as a plain number; `Infinity` (or null) when there is no debt. */
export function statusFor(healthFactor: number | null, bands: RiskBands = RISK): Status {
  if (healthFactor === null || !Number.isFinite(healthFactor)) return "none";
  if (healthFactor >= bands.safeMin) return "safe";
  if (healthFactor >= bands.watchMin) return "watch";
  return "act";
}

/**
 * Home always shows one of the three words (canvas "Turn on credit"), so nothing owed reads Safe there (F2-1):
 * the health factor is unbounded, above every band.
 */
export const homeStatus = (s: Status): Exclude<Status, "none"> => (s === "none" ? "safe" : s);

/**
 * Actions that end in Watch need an extra explicit confirmation (D2). Ending in Act is not confirmed but blocked, with
 * one plain line ("Act is the line", Adrian 2026-10-15): taking credit and Free up check `endsInAct` instead.
 */
export const needsExtraConfirm = (after: Status) => after === "watch";

/** It would end in Act: taking credit or freeing up backing that does is blocked, never confirmed (Act is the line). */
export const endsInAct = (after: Status) => after === "act";

export const STATUS_LABEL: Record<Status, string> = {
  // D17: never "loan" on screen.
  none: "No credit",
  safe: "Safe",
  watch: "Watch",
  act: "Act",
};


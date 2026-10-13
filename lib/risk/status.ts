import { RISK, type RiskBands } from "@/config/risk";

export type Status = "none" | "safe" | "watch" | "act";

/** `healthFactor` as a plain number; `Infinity` (or null) when there is no debt. */
export function statusFor(healthFactor: number | null, bands: RiskBands = RISK): Status {
  if (healthFactor === null || !Number.isFinite(healthFactor)) return "none";
  if (healthFactor >= bands.safeMin) return "safe";
  if (healthFactor >= bands.watchMin) return "watch";
  return "act";
}

/** Actions that end in Watch or Act need an extra explicit confirmation. */
export const needsExtraConfirm = (after: Status) => after === "watch" || after === "act";

export const STATUS_LABEL: Record<Status, string> = {
  none: "No loan",
  safe: "Safe",
  watch: "Watch",
  act: "Act",
};

export const STATUS_COPY: Record<Status, string> = {
  none: "You have no loan.",
  safe: "Your loan is healthy.",
  watch: "Your loan is getting close to Aave's limit. Consider repaying or adding collateral.",
  act: "Your loan is at high risk of liquidation. Repay or add collateral now.",
};

import { RISK } from "@/config/risk";
import type { HealthFloor } from "@/lib/tx/prepared";

/*
 * Free up's line (Act is the line, Adrian 2026-10-15): stock taken out of backing never leaves the credit in Act. What
 * can come out, for one stock or several, is lib/freeUpPlan.ts; every batch that takes stock out is checked again on
 * Aave's own health before JAW's sheet (FREE_UP_FLOOR).
 */

export const FREE_UP_BLOCKED = {
  act: "That would put your credit in Act. Free up less, or repay some first.",
} as const;

/** A batch that takes stock out of backing is stopped if the health on Aave after it, read in its simulation, is in Act. */
export const FREE_UP_FLOOR: HealthFloor = { minHf: RISK.watchMin, stop: FREE_UP_BLOCKED.act };

import { MIX_WHOLE } from "@/lib/agents/mix";
import type { StockLimits } from "@/lib/agents/permissions";
import type { RebalanceCardModel, Side } from "@/lib/agents/rebalanceCard";
import { topUpsChanged, type TopUpsChoice, type TopUpsSetting } from "@/lib/agents/topUps";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * Rebalance's sheet (boards 7e–7h): its line under the title, My mix, Top-ups go into my mix, and what saving takes
 * (`rebalanceSteps`). A new grant (none yet, one capped below the executor's CAP_MAX from before the Rebalancer had no
 * amount limit, a stock in the mix it has no sell limit for, or top-ups switched on or off, since the grant carries
 * Aave's savings withdraw only while they're on) opens JAW's sheet, then one batch carries the settings that changed
 * and the grant's registration; with no grant, the settings alone (Adrian, 2026-10-20: "Batch those into one").
 */

/**
 * What saving runs, one JAW sheet each: the grant then the batch, the batch alone when this sheet's grant is still
 * waiting for it (`waiting`: a batch that didn't go through), the settings alone ("mix": `setMix` and, once the executor
 * counts top-ups, `setTopUps`, whichever changed), or nothing. useManageSave runs exactly these, so the count the
 * button shows is what opens.
 */
export function rebalanceSteps(p: {
  needsGrant: boolean;
  mixChanged: boolean;
  topUpsChanged?: boolean;
  waiting: boolean;
}): ("grant" | "batch" | "mix")[] {
  if (p.needsGrant) return ["grant", "batch"];
  if (p.waiting) return ["batch"];
  return p.mixChanged || p.topUpsChanged ? ["mix"] : [];
}

/**
 * What the Rebalancer runs with now: its grant's USDC limit and each stock's, and whether it carries Aave's savings
 * withdraw (top-ups on), while it has one.
 */
export type RebalanceTerms = { capRaw: bigint; limitsRaw?: StockLimits; topUps?: boolean } | null | undefined;

export type SavePlan = {
  mixChanged: boolean;
  topUpsChanged: boolean;
  needsGrant: boolean;
  /** How many times saving opens JAW's sheet (0 when there is nothing to save: the button doesn't show). */
  steps: number;
  canSave: boolean;
  /** Why it can't save, under the button; null when it can (the button says "2 steps" itself). */
  note: string | null;
};

type SaveInput = {
  configured: boolean;
  connected: boolean;
  /** The registry's mix, BPS by reserve id (all 0 before one is saved); null before it is read. */
  saved: readonly number[] | null;
  /** The mix on screen, BPS by reserve id. */
  weights: readonly number[];
  terms: RebalanceTerms;
  /** The executor's CAP_MAX, what a grant made now carries (no amount limit); null before it is read. */
  capMaxRaw: bigint | null;
  /** Whether the Rebalancer runs now (on, or registering). */
  running: boolean;
  /** This sheet's grant landed and its batch didn't: Save sends that batch (useManageSave `registering`). */
  waiting?: boolean;
  /** Top-ups go into my mix: what the executor has (null until it counts top-ups) and what's on screen. */
  topUps?: { saved: TopUpsSetting | null; chosen: TopUpsChoice };
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
};

/**
 * Whether saving takes a new grant: none yet; one capped below CAP_MAX, from before the Rebalancer had no amount limit;
 * a stock in the mix it can't sell yet; or top-ups switched on or off (`topUpsOn`, null while they don't count), since
 * the withdraw rides in the grant only while they're on.
 */
function grantNeeded(p: SaveInput, topUpsOn: boolean | null): boolean {
  const t = p.terms;
  if (!t) return true;
  if (p.capMaxRaw !== null && t.capRaw !== p.capMaxRaw) return true;
  if (p.weights.some((w, r) => w > 0 && !((t.limitsRaw?.[r] ?? 0n) > 0n))) return true;
  return topUpsOn !== null && topUpsOn !== !!t.topUps;
}

/** Why Save can't go ahead, under it; null when it can. */
function saveNote(p: SaveInput, whole: boolean, keepMissing: boolean): string | null {
  if (!p.configured) return "Not live yet";
  if (p.connected && p.feeBlocked) return "Your account can’t pay network fees from your cash right now.";
  if (!whole) return "Make your mix add up to 100% to save it.";
  return keepMissing ? "Enter an amount" : null;
}

export function rebalanceSave(p: SaveInput): SavePlan {
  const whole = p.weights.reduce((a, b) => a + b, 0) === MIX_WHOLE;
  const mixChanged = p.configured && p.saved !== null && p.weights.some((w, r) => w !== p.saved![r]);
  // Nothing about top-ups counts until the executor's setting is read.
  const topUps = p.configured && p.topUps?.saved ? p.topUps : null;
  const topUpsMoved = !!topUps && topUpsChanged(topUps.saved, topUps.chosen);
  const needsGrant = p.configured && grantNeeded(p, topUps ? topUps.chosen.on : null);
  const steps = rebalanceSteps({ needsGrant, mixChanged, topUpsChanged: topUpsMoved, waiting: !!p.waiting }).length;
  const keepMissing = !!topUps && topUps.chosen.on && topUps.chosen.keepUsd === null;
  const note = saveNote(p, whole, keepMissing);
  const canSave = p.connected && note === null && steps > 0 && p.capMaxRaw !== null && !p.feeLoading && !p.busy;
  return { mixChanged, topUpsChanged: topUpsMoved, needsGrant, steps, canSave, note };
}

/** "tomorrow 10:00 AM" back from the card's capitalised "Tomorrow 10:00 AM" (a weekday keeps its capital). */
const lower = (when: string) => (/^(Today|Tomorrow) /.test(when) ? when[0].toLowerCase() + when.slice(1) : when);

/** The stocks the next check trades on `side`, as one list ("Apple and Meta"); null when none. */
const names = (model: RebalanceCardModel, side: Side) => {
  const n = model.slots.filter((s) => s.side === side).map((s) => EQUITIES[s.reserveId].name);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : (n[0] ?? null);
};

/**
 * The line under the sheet's title, from Rebalance's card (lib/agents/rebalanceCard.ts), so the two never disagree:
 * "On target. Checks tomorrow 10:00 AM." (board 7e), the trades due and which stocks, or the state's own words. Renew
 * sits after it while the grant ends within the week.
 */
export function sheetLine(model: RebalanceCardModel): { text: string; renew: boolean } {
  const f = model.footer;
  if (f.kind === "on-target") return { text: `On target. Checks ${lower(f.next)}.`, renew: false };
  if (f.kind === "trades") {
    const sells = names(model, "sell");
    const buys = names(model, "buy");
    const what = `${sells ? ` Sells ${sells}.` : ""}${buys ? ` Buys ${buys}.` : ""}`;
    return { text: `${f.text} ${lower(f.when)}.${what}`, renew: false };
  }
  return { text: f.line2 ? `${f.line1} ${f.line2}` : f.line1, renew: model.pill.text === "Ends soon" };
}

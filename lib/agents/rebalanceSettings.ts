import type { Call } from "@/lib/aave/tx";
import { MIX_WHOLE } from "@/lib/agents/mix";
import { startCapRaw, type AgentJob, type StockLimits } from "@/lib/agents/permissions";
import type { RebalanceCardModel, Side } from "@/lib/agents/rebalanceCard";
import { buildSetMixCalls, buildSetTopUpsCalls } from "@/lib/agents/settings";
import type { AgentStatus } from "@/lib/agents/status";
import { keepRawOf, keepText, topUpsChanged, type TopUpsChoice, type TopUpsSetting } from "@/lib/agents/topUps";
import { earningAllowsText } from "@/lib/cashSetup";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * Rebalance's sheet (boards 7e–7h): its line under the title, My mix, Top-ups go into my mix, and what saving takes
 * (`rebalanceSteps`). Saving is one batch, one Face ID (Adrian, 2026-10-20: "the permission, the cash move and the
 * registration in one signature"): the settings that changed (`setMix` and, once the executor counts top-ups,
 * `setTopUps`) and a new grant when one is needed (none yet, one capped below the executor's CAP_MAX from before the
 * Rebalancer had no amount limit, a stock in the mix it has no sell limit for, or top-ups switched on or off, since the
 * grant carries Aave's savings withdraw only while they're on), approved and registered, with the grant it replaces
 * revoked.
 */

/**
 * What saving runs: one batch when anything changed (a new grant, the mix, top-ups), else nothing. useManageSave sends
 * exactly it.
 */
export function rebalanceSteps(p: { needsGrant: boolean; mixChanged: boolean; topUpsChanged?: boolean }): "batch"[] {
  return p.needsGrant || p.mixChanged || p.topUpsChanged ? ["batch"] : [];
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
  /** How many batches saving sends: 1, or 0 when there is nothing to save (the button doesn't show). */
  steps: number;
  canSave: boolean;
  /** Why it can't save, under the button; null when it can. */
  note: string | null;
  /** What the Face ID lets Rebalance do (`rebalanceAllows`), above Save while it grants; null otherwise. */
  allows: string | null;
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
  /** Top-ups go into my mix: what the executor has (null until it counts top-ups) and what's on screen. */
  topUps?: { saved: TopUpsSetting | null; chosen: TopUpsChoice };
  /** Earning (the Save job) is off, so turning top-ups on grants it in the same batch (P3). */
  earningOff?: boolean;
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
  const steps = rebalanceSteps({ needsGrant, mixChanged, topUpsChanged: topUpsMoved }).length;
  const keepMissing = !!topUps && topUps.chosen.on && topUps.chosen.keepUsd === null;
  const note = saveNote(p, whole, keepMissing);
  const canSave = p.connected && note === null && steps > 0 && p.capMaxRaw !== null && !p.feeLoading && !p.busy;
  // Said only while Save grants, and not while Keep is empty: the line would name an amount nobody typed.
  const allows = needsGrant && !keepMissing ? allowsLine(p, topUps?.chosen ?? null) : null;
  return { mixChanged, topUpsChanged: topUpsMoved, needsGrant, steps, canSave, note, allows };
}

/**
 * The allows line for a Save that grants: Rebalance's (`rebalanceAllows`), and while top-ups are on and earning is
 * off, earning's own line after it (Start earning's words, with no amount limit: P2), since the same Face ID grants
 * earning too (P3, `rebalanceChange`).
 */
function allowsLine(p: SaveInput, chosen: TopUpsChoice | null): string {
  const line = rebalanceAllows(chosen?.on ? { keepUsd: chosen.keepUsd ?? 0 } : undefined);
  const earningToo = !!chosen?.on && !!p.earningOff;
  return earningToo ? `${line} ${earningAllowsText()}` : line;
}

/**
 * What a Save's one Face ID lets Rebalance do when it grants (JAW's batch sheet shows no words of ours). With top-ups
 * on, it also puts the cash above what the user keeps into the mix (all of it with Keep $0), so the line says so
 * (`topUps`, wired in M5).
 */
export function rebalanceAllows(topUps?: { keepUsd: number }): string {
  if (!topUps)
    return "Rebalance can trade your stocks toward your mix, for a year. It never spends your cash. You can turn it off here.";
  const into = topUps.keepUsd > 0 ? `your top-ups above ${keepText(topUps.keepUsd)}` : "every top-up";
  return `Rebalance can trade your stocks toward your mix, and put ${into} into it, for a year. You can turn it off here.`;
}

/** A grant in a change's batch, as useAgents `changePlan` takes it (its GrantStep). */
type GrantAsk = { job: AgentJob; capRaw: bigint; limitsRaw?: StockLimits; topUps?: boolean };

/**
 * What Rebalance's Save asks for (useManageSave): the mix (`setMix`, when it changed), the Rebalancer's new grant when
 * one is needed (carrying top-ups while they're on), and top-ups as chosen (`setTopUps`, when they changed; null until
 * the executor's setting is read, or on an executor that doesn't count them).
 */
export type MixSave = {
  weights: readonly number[];
  mixChanged: boolean;
  grant: GrantAsk | null;
  topUps: TopUpsSetting | null;
  topUpsChanged: boolean;
};

/**
 * Whether the batch also grants earning (the Save job), in the same signature (P3): only Save counts top-ups, so a Save
 * whose Rebalancer grant carries them (turning them on, or granting anew with them on) turns earning on too while it's
 * off. A Keep-only change grants nothing. Null while earning's state is still loading: the batch waits rather than
 * leave top-ups on with nothing to count them.
 */
function earningGrant(p: MixSave, earning: { save: AgentStatus; capMaxRaw: bigint | null }): GrantAsk[] | null {
  if (!p.grant?.topUps) return [];
  if (earning.save === "loading" || earning.capMaxRaw === null) return null;
  return earning.save === "off" ? [{ job: "save", capRaw: startCapRaw("save", earning.capMaxRaw) }] : [];
}

/**
 * Save's one batch, for useAgents `changePlan` (useManageSave): the new grants (the Rebalancer's, and earning's when
 * top-ups turn on while it's off) and the registry settings, `setMix` when the mix changed then `setTopUps` when
 * top-ups changed. A Keep-only change is settings alone, with no grant. Null when there's nothing to save, or while
 * earning's state loads; it throws only on what the sheet never sends (a mix that doesn't add up, Keep past $1,000,000),
 * and useManageSave says so at the button.
 */
export function rebalanceChange(
  account: `0x${string}`,
  p: MixSave,
  earning: { save: AgentStatus; capMaxRaw: bigint | null },
): { grants: GrantAsk[]; settings: Call[] } | null {
  const save = earningGrant(p, earning);
  if (!save) return null;
  const grants = [...(p.grant ? [p.grant] : []), ...save];
  const settings = [
    ...(p.mixChanged ? buildSetMixCalls(account, p.weights) : []),
    ...(p.topUps && p.topUpsChanged ? buildSetTopUpsCalls(account, p.topUps.on, keepRawOf(p.topUps.keepUsd)) : []),
  ];
  return grants.length > 0 || settings.length > 0 ? { grants, settings } : null;
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

import type { Call } from "@/lib/aave/tx";
import { MIX_WHOLE } from "@/lib/agents/mix";
import { startCapRaw, type AgentJob, type StockLimits } from "@/lib/agents/permissions";
import type { RebalanceCardModel, Side } from "@/lib/agents/rebalanceCard";
import { buildSetMixCalls, buildSetTopUpsCalls } from "@/lib/agents/settings";
import type { AgentStatus } from "@/lib/agents/status";
import { keepRawOf, keepText, topUpsChanged, type TopUpsChoice, type TopUpsSetting } from "@/lib/agents/topUps";
import { earningAllowsText } from "@/lib/cashSetup";
import { formatUsdTrim } from "@/lib/formatting";
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
  /**
   * "The $300 waiting stays as cash.": the Save starts the counts again (a new Rebalancer grant, or the switch flipped)
   * while a top-up waits, so it never goes in. Null otherwise.
   */
  keeps: string | null;
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
  /** A counted top-up waiting for Rebalance's next check, in dollars; null or 0 when none. */
  waitingUsd?: number | null;
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
};

/** Top-ups once the executor's setting is read: what it has and what's on screen. Null before (nothing counts). */
type ReadTopUps = { saved: TopUpsSetting; chosen: TopUpsChoice } | null;

const readTopUpsOf = (p: SaveInput): ReadTopUps =>
  p.configured && p.topUps?.saved ? { saved: p.topUps.saved, chosen: p.topUps.chosen } : null;

/**
 * Whether saving takes a new grant: none yet; one capped below CAP_MAX, from before the Rebalancer had no amount limit;
 * a stock in the mix it can't sell yet; or top-ups switched on or off (null while they don't count), since the withdraw
 * rides in the grant only while they're on. While Rebalance isn't running (its grant ran out or was stopped), switching
 * top-ups off alone takes none: it's the setting only (`setTopUps(false)`), so stopping Save counting them never makes
 * the user turn Rebalance on.
 */
function grantNeeded(p: SaveInput, topUps: ReadTopUps, mixChanged: boolean): boolean {
  if (!p.running && !mixChanged && topUps?.saved.on && !topUps.chosen.on) return false;
  const t = p.terms;
  if (!t) return true;
  if (p.capMaxRaw !== null && t.capRaw !== p.capMaxRaw) return true;
  if (p.weights.some((w, r) => w > 0 && !((t.limitsRaw?.[r] ?? 0n) > 0n))) return true;
  return !!topUps && topUps.chosen.on !== !!t.topUps;
}

/** The app's own wait word: Save holds until the top-ups switch is read. */
const ONE_MOMENT = "One moment…";

/** Why Save can't go ahead, under it; null when it can. */
function saveNote(p: SaveInput, whole: boolean, wait: { keepMissing: boolean; unread: boolean }): string | null {
  if (!p.configured) return "Not live yet";
  if (p.connected && p.feeBlocked) return "Your account can’t pay network fees from your cash right now.";
  if (!whole) return "Make your mix add up to 100% to save it.";
  if (wait.unread) return ONE_MOMENT;
  return wait.keepMissing ? "Enter an amount" : null;
}

/**
 * What Save waits for: an amount in an empty Keep, or the switch's read while the grant running now carries top-ups
 * (`unread`): a new grant's line would say "It never spends your cash." over a grant with the savings withdraw, so a
 * Save that grants waits for the read.
 */
function waitsFor(p: SaveInput, topUps: ReadTopUps, needsGrant: boolean) {
  return {
    keepMissing: !!topUps && topUps.chosen.on && topUps.chosen.keepUsd === null,
    unread: needsGrant && !topUps && !!p.terms?.topUps,
  };
}

/**
 * "The $300 waiting stays as cash.": a new Rebalancer grant, or the switch flipped, starts the executor's counts again,
 * so a top-up waiting for the next check never goes in. Null when nothing waits or the Save keeps the count.
 */
function keepsLine(p: SaveInput, topUps: ReadTopUps, needsGrant: boolean): string | null {
  const restarts = needsGrant || (!!topUps && topUps.chosen.on !== topUps.saved.on);
  const waiting = p.waitingUsd ?? 0;
  return restarts && waiting >= 0.01 ? `The ${formatUsdTrim(waiting)} waiting stays as cash.` : null;
}

export function rebalanceSave(p: SaveInput): SavePlan {
  const whole = p.weights.reduce((a, b) => a + b, 0) === MIX_WHOLE;
  const mixChanged = p.configured && p.saved !== null && p.weights.some((w, r) => w !== p.saved![r]);
  const topUps = readTopUpsOf(p);
  const topUpsMoved = !!topUps && topUpsChanged(topUps.saved, topUps.chosen);
  const needsGrant = p.configured && grantNeeded(p, topUps, mixChanged);
  const steps = rebalanceSteps({ needsGrant, mixChanged, topUpsChanged: topUpsMoved }).length;
  const wait = waitsFor(p, topUps, needsGrant);
  const note = saveNote(p, whole, wait);
  const canSave = p.connected && note === null && steps > 0 && p.capMaxRaw !== null && !p.feeLoading && !p.busy;
  // Said only while Save grants, and not while Keep is empty (the line would name an amount nobody typed) or the
  // switch is unread (the line could contradict the grant).
  const allows = needsGrant && !wait.keepMissing && !wait.unread ? allowsLine(p, topUps?.chosen ?? null) : null;
  const keeps = steps > 0 ? keepsLine(p, topUps, needsGrant) : null;
  return { mixChanged, topUpsChanged: topUpsMoved, needsGrant, steps, canSave, note, allows, keeps };
}

/**
 * The toast once a Save lands, from what it saved: "Your mix is saved" only when the mix changed; Rebalance turned on
 * by it; top-ups (the switch or Keep) alone; else "Saved" (a grant again at CAP_MAX, nothing on screen changed).
 */
export function savedText(plan: Pick<SavePlan, "mixChanged" | "topUpsChanged" | "needsGrant">, running: boolean) {
  if (plan.mixChanged) return "Your mix is saved";
  if (plan.needsGrant && !running) return "Rebalance is on";
  return plan.topUpsChanged ? "Top-ups saved" : "Saved";
}

/**
 * The allows line for a Save that grants (`rebalanceAllows`): with earning's own words too while top-ups are on and
 * earning is off, since the same Face ID grants earning (P3, `rebalanceChange`).
 */
function allowsLine(p: SaveInput, chosen: TopUpsChoice | null): string {
  return rebalanceAllows(chosen?.on ? { keepUsd: chosen.keepUsd ?? 0 } : undefined, !!chosen?.on && !!p.earningOff);
}

/**
 * What a Save's one Face ID lets Rebalance do when it grants (JAW's batch sheet shows no words of ours). With top-ups
 * on, it also puts the cash above what the user keeps into the mix (all of it with Keep $0), so the line says so. With
 * `earning`, earning's words (Start earning's, no amount limit) come before the turn-off, which ends the line and then
 * names Rebalance, since its "it" would read as earning.
 */
export function rebalanceAllows(topUps?: { keepUsd: number }, earning = false): string {
  const into = topUps && (topUps.keepUsd > 0 ? `your top-ups above ${keepText(topUps.keepUsd)}` : "every top-up");
  const can = into
    ? `Rebalance can trade your stocks toward your mix, and put ${into} into it, for a year.`
    : "Rebalance can trade your stocks toward your mix, for a year. It never spends your cash.";
  return earning
    ? `${can} ${earningAllowsText()} You can turn Rebalance off here.`
    : `${can} You can turn it off here.`;
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

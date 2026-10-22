import type { Call } from "@/lib/aave/tx";
import { MIX_WHOLE } from "@/lib/agents/mix";
import type { AgentJob, StockLimits } from "@/lib/agents/permissions";
import type { RebalanceCardModel, Side } from "@/lib/agents/rebalanceCard";
import { buildSetMixCalls, buildSetTopUpsCalls } from "@/lib/agents/settings";
import type { AgentStatus } from "@/lib/agents/status";
import { keepRawOf, keepText, topUpsChanged, type TopUpsChoice, type TopUpsSetting } from "@/lib/agents/topUps";
import { formatUsdTrim } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * Rebalance's sheet (boards 7e–7h): its line under the title, My mix, Top-ups go into my mix, and what saving takes
 * (`rebalanceSteps`). Saving is one batch, one Face ID (Adrian, 2026-10-20: "the permission, the cash move and the
 * registration in one signature"): the settings that changed (`setMix`, `setTopUps`) and a new grant when one is
 * needed (none yet, or a stock in the mix it may not sell yet), approved and registered, with the grant it replaces
 * revoked. Top-ups are a setting in GooseGuard: switching them on or off takes no new grant.
 */

/**
 * What saving runs: one batch when anything changed (a new grant, the mix, top-ups), else nothing. useManageSave sends
 * exactly it.
 */
export function rebalanceSteps(p: { needsGrant: boolean; mixChanged: boolean; topUpsChanged?: boolean }): "batch"[] {
  return p.needsGrant || p.mixChanged || p.topUpsChanged ? ["batch"] : [];
}

/** What the Rebalancer runs with now, while it has a grant: the stocks it may sell. */
export type RebalanceTerms = { limitsRaw?: StockLimits } | null | undefined;

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
  /** "The $300 waiting stays as cash.": the Save switches top-ups off while some wait to go in. Null otherwise. */
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
  /** Whether the Rebalancer runs now (on, or registering). */
  running: boolean;
  /** Top-ups go into my mix: what the Guard has (null until it's read) and what's on screen. */
  topUps?: { saved: TopUpsSetting | null; chosen: TopUpsChoice };
  /** Earning (the Save job) is off, so turning top-ups on grants it in the same batch (P3). */
  earningOff?: boolean;
  /** Top-ups waiting in the wallet to go in at the next round, in dollars; null or 0 when none. */
  waitingUsd?: number | null;
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
};

/** Top-ups once the Guard's setting is read: what it has and what's on screen. Null before. */
type ReadTopUps = { saved: TopUpsSetting; chosen: TopUpsChoice } | null;

const readTopUpsOf = (p: SaveInput): ReadTopUps =>
  p.configured && p.topUps?.saved ? { saved: p.topUps.saved, chosen: p.topUps.chosen } : null;

/**
 * Whether saving takes a new grant: none yet, or a stock in the mix it may not sell yet. Top-ups are a setting in
 * GooseGuard, so switching them takes none. While Rebalance isn't running (its grant ran out or was stopped), switching
 * top-ups off alone takes none either: it's the setting only (`setTopUps(false)`), so leaving the cash as cash never
 * makes the user turn Rebalance on.
 */
function grantNeeded(p: SaveInput, topUps: ReadTopUps, mixChanged: boolean): boolean {
  if (!p.running && !mixChanged && topUps?.saved.on && !topUps.chosen.on) return false;
  const t = p.terms;
  if (!t) return true;
  return p.weights.some((w, r) => w > 0 && !((t.limitsRaw?.[r] ?? 0n) > 0n));
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
 * What Save waits for: an amount in an empty Keep, or the switch's read while Save grants (`unread`): the new grant's
 * line says whether the Rebalancer puts top-ups in, which is the Guard's setting, so a Save that grants waits for it.
 */
function waitsFor(p: SaveInput, topUps: ReadTopUps, needsGrant: boolean) {
  return {
    keepMissing: !!topUps && topUps.chosen.on && topUps.chosen.keepUsd === null,
    unread: needsGrant && p.configured && !!p.topUps && !topUps,
  };
}

/**
 * "The $300 waiting stays as cash.": the Save switches top-ups off while some wait in the wallet, so they stay as cash
 * (and earning puts them in savings). Null when nothing waits or top-ups stay on.
 */
function keepsLine(p: SaveInput, topUps: ReadTopUps): string | null {
  const off = !!topUps && topUps.saved.on && !topUps.chosen.on;
  const waiting = p.waitingUsd ?? 0;
  return off && waiting >= 0.01 ? `The ${formatUsdTrim(waiting)} waiting stays as cash.` : null;
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
  const canSave = p.connected && note === null && steps > 0 && !p.feeLoading && !p.busy;
  // Said only while Save grants, and not while Keep is empty (the line would name an amount nobody typed) or the
  // switch is unread (the line could contradict the grant).
  const allows = needsGrant && !wait.keepMissing && !wait.unread ? allowsLine(p, topUps?.chosen ?? null) : null;
  const keeps = steps > 0 ? keepsLine(p, topUps) : null;
  return { mixChanged, topUpsChanged: topUpsMoved, needsGrant, steps, canSave, note, allows, keeps };
}

/**
 * The toast once a Save lands, from what it saved: "Your mix is saved" only when the mix changed; Rebalance turned on
 * by it; top-ups (the switch or Keep) alone; else "Saved" (a grant again, nothing on screen changed).
 */
export function savedText(plan: Pick<SavePlan, "mixChanged" | "topUpsChanged" | "needsGrant">, running: boolean) {
  if (plan.mixChanged) return "Your mix is saved";
  if (plan.needsGrant && !running) return "Rebalancer is on";
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
 * What the same Face ID lets earning do when a Save grants it too (P3): the words Start earning's card said before its
 * own line went (2026-10-20, "One card, nothing else"), which Rebalance's sheet keeps. Save has no amount limit (P2).
 */
const EARNING_ALLOWS = "New cash that arrives moves into savings on its own.";

/**
 * What a Save's one Face ID lets Rebalance do when it grants (JAW's batch sheet shows no words of ours). With top-ups
 * on, it also puts the cash above what the user keeps into the mix (all of it with Keep $0), so the line says so. With
 * `earning`, earning's words (`EARNING_ALLOWS`) come before the turn-off, which ends the line and then names
 * Rebalance, since its "it" would read as earning.
 */
export function rebalanceAllows(topUps?: { keepUsd: number }, earning = false): string {
  const into = topUps && (topUps.keepUsd > 0 ? `your top-ups above ${keepText(topUps.keepUsd)}` : "every top-up");
  const can = into
    ? `Rebalancer can trade your stocks toward your mix, and put ${into} into it, for a year.`
    : "Rebalancer can trade your stocks toward your mix, for a year. It never spends your cash.";
  return earning ? `${can} ${EARNING_ALLOWS} You can turn Rebalancer off here.` : `${can} You can turn it off here.`;
}

/** A grant in a change's batch, as useAgents `changePlan` takes it (its GrantStep). */
type GrantAsk = { job: AgentJob; limitsRaw?: StockLimits };

/**
 * What Rebalance's Save asks for (useManageSave): the mix (`setMix`, when it changed), the Rebalancer's new grant when
 * one is needed, and top-ups as chosen (`setTopUps`, when they changed; null until the Guard's setting is read), with
 * whether this Save turns them on (its batch then puts the wallet's cash into savings first).
 */
export type MixSave = {
  weights: readonly number[];
  mixChanged: boolean;
  grant: GrantAsk | null;
  topUps: TopUpsSetting | null;
  topUpsChanged: boolean;
  topUpsTurningOn: boolean;
};

/**
 * Whether the batch also grants earning (the Save job), in the same signature (P3): with top-ups on, earning keeps Keep
 * as cash in savings, so turning them on (or changing Keep while they're on) turns earning on too while it's off. Null
 * while earning's state is still loading: the batch waits rather than leave Keep with nothing to fill it.
 */
function earningGrant(p: MixSave, earning: { save: AgentStatus }): GrantAsk[] | null {
  if (!p.topUps?.on || !p.topUpsChanged) return [];
  if (earning.save === "loading") return null;
  return earning.save === "off" ? [{ job: "save" }] : [];
}

/**
 * Save's one batch, for useAgents `changePlan` (useManageSave): the new grants (the Rebalancer's, and earning's when
 * top-ups turn on while it's off) and the Guard settings, `setMix` when the mix changed then `setTopUps` when top-ups
 * changed. A switch-only or Keep-only change is settings alone, with no Rebalancer grant. Null when there's nothing to
 * save, or while earning's state loads; it throws only on what the sheet never sends (a mix that doesn't add up, Keep
 * past $1,000,000), and useManageSave says so at the button.
 */
export function rebalanceChange(
  account: `0x${string}`,
  p: MixSave,
  earning: { save: AgentStatus },
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

/** "tomorrow 5 PM GMT+3" back from the card's capitalised "Tomorrow 5 PM GMT+3" (a weekday keeps its capital). */
const lower = (when: string) => (/^(Today|Tomorrow) /.test(when) ? when[0].toLowerCase() + when.slice(1) : when);

/** The stocks the next check trades on `side`, as one list ("Apple and Meta"); null when none. */
const names = (model: RebalanceCardModel, side: Side) => {
  const n = model.slots.filter((s) => s.side === side).map((s) => EQUITIES[s.reserveId].name);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : (n[0] ?? null);
};

/**
 * The line under the sheet's title, from Rebalance's card (lib/agents/rebalanceCard.ts), so the two never disagree:
 * "On target. Checks tomorrow 10:00 AM." (board 7e), the top-ups going in or the trades due and which stocks, or the
 * state's own words. Renew sits after it whenever the grant ends within the week, whatever the line says (Adrian,
 * 2026-10-20), so a grant never runs out unnoticed behind trades due or a pause.
 */
export function sheetLine(model: RebalanceCardModel): { text: string; renew: boolean } {
  const f = model.footer;
  const renew = model.endsSoon;
  if (f.kind === "on-target") return { text: `On target. Checks ${lower(f.next)}.`, renew };
  // Trades due, or top-ups going in ("$300 going in tomorrow 10:00 AM. Buys NVIDIA."): what it sells and buys.
  if (f.kind === "trades" || f.kind === "invest") {
    const sells = names(model, "sell");
    const buys = names(model, "buy");
    const what = `${sells ? ` Sells ${sells}.` : ""}${buys ? ` Buys ${buys}.` : ""}`;
    return { text: `${f.text} ${lower(f.when)}.${what}`, renew };
  }
  return { text: f.line2 ? `${f.line1} ${f.line2}` : f.line1, renew };
}

import { mixBpsNow, startingMix, type MixHolding } from "@/lib/agents/mix";
import { rebalanceCheckAt, whenText, type RebalanceOutlook } from "@/lib/agents/next";
import { bandOf, type RebalanceOptions, type RebalanceTrade } from "@/lib/agents/rules/rebalance";
import type { AgentStatus } from "@/lib/agents/status";
import { EQUITIES } from "@/lib/tokens/registry";

/*
 * Rebalance's card on the Agents overview: one slot per stock in the mix, in Home's order, each with its target on top
 * and its logo placed by how far it sits from its target, measured in its own band, so every stock reads on the same
 * scale whatever its size. The slots of the stocks the next check trades are tinted (sell red, buy green) with a ghost
 * where the logo goes back to. Under it, "On target" and the next check, or the trades due and when, or the state's
 * words. One pill says what Rebalance itself is doing; the first state that applies wins, in the order of board 7.
 * Nothing on the card can be tapped on its own: the whole card opens Rebalance's sheet. Pure, so the gallery and the
 * tests draw every state with the app's own words.
 */

/**
 * How far a logo may sit from the target line, in bands. The view draws a band as 22px and the slot leaves 23.5px
 * between the line and the logo's edge stop, so a stock far past its band stays readable inside its slot.
 */
export const OFFSET_MAX = 23.5 / 22;

/** What the next check does to a stock: from the trades, never from the drift. */
export type Side = "sell" | "buy";

export type MixSlot = {
  reserveId: number;
  /** Its target, BPS of the mix; null when no mix is saved and nothing is held (the seven stocks, with no target). */
  targetBps: number | null;
  /** (now − target) ÷ its band: 0 on target, ±1 at its band's edge (+ above), clamped to ±OFFSET_MAX. */
  offset: number;
  side: Side | null;
};

const clamp = (x: number) => Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, x)) + 0; // + 0: never −0

/**
 * The picture's slots. With a saved mix: its stocks, each placed by its share of the mix's free stock now against its
 * target, in its band (`bandOf`, as the rule measures it); its side comes from `trades`, since the other leg of a trade
 * can buy or sell a stock still inside its band. Before a mix is saved: the stocks held now, at their share now (as
 * the sheet opens on them), all on target. Nothing saved and nothing held: the seven stocks, with no target.
 */
export function mixSlots(p: {
  holdings: readonly MixHolding[];
  mixBps: readonly number[] | null;
  options: Pick<RebalanceOptions, "bandBps" | "bandMaxBps">;
  trades: readonly RebalanceTrade[];
}): MixSlot[] {
  const mix = p.mixBps?.some((w) => w > 0) ? p.mixBps : null;
  if (!mix) {
    const held = startingMix(p.holdings, null).sort((a, b) => a.reserveId - b.reserveId);
    if (held.length === 0)
      return EQUITIES.map((e) => ({ reserveId: e.reserveId, targetBps: null, offset: 0, side: null }));
    return held.map((r) => ({ reserveId: r.reserveId, targetBps: r.bps, offset: 0, side: null }));
  }
  const now = mixBpsNow(p.holdings, mix);
  const sides = new Map(p.trades.map((t) => [t.reserveId, t.buy ? ("buy" as const) : ("sell" as const)]));
  return EQUITIES.filter((e) => mix[e.reserveId] > 0).map((e) => {
    const target = mix[e.reserveId];
    const band = Number(bandOf(BigInt(target), p.options));
    const drift = now ? now[e.reserveId] - target : 0;
    return {
      reserveId: e.reserveId,
      targetBps: target,
      offset: clamp(band > 0 ? drift / band : Math.sign(drift) * OFFSET_MAX),
      side: sides.get(e.reserveId) ?? null,
    };
  });
}

/** The pill's colours: running, neutral (off, paused, coming soon), needs the user, and a trade or a date due. */
export type PillTone = "on" | "neutral" | "needs" | "due";

export type RebalanceFooter =
  | { kind: "on-target"; next: string }
  | { kind: "trades"; text: string; when: string }
  | { kind: "words"; line1: string; line2: string | null };

export type RebalanceCardModel = {
  pill: { text: string; tone: PillTone };
  /** The picture at 60%: Rebalance isn't running (not live yet, needs the user, stopped, off). */
  faded: boolean;
  slots: MixSlot[];
  footer: RebalanceFooter;
  /** The whole card's name for screen readers: name, pill, then what it does now. */
  label: string;
};

export type RebalanceCardInput = {
  /** The agents can be switched on (AGENTS_LIVE); until then the card says they're coming. */
  live: boolean;
  nowSec: number;
  /** The Rebalancer's state (agentStatus): "loading" draws no model, the card's frame waits for it. */
  status: AgentStatus;
  /** JAW granted it and the executor doesn't run it yet: its registration is still to go (useAgents `toFinish`). */
  waiting: boolean;
  /** When it stopped without the user turning it off; null when it didn't. */
  stoppedAt: number | null;
  /** Its grant's end while it has one. */
  endsAt: number | null;
  /** Failed runs in a row (the account's), and when the executor tries again. */
  fails: number;
  cooldownUntil: number;
  /** The New York day it last traded (the registry's `accounts`). */
  rebalanceDay: number;
  holdings: readonly MixHolding[];
  mixBps: readonly number[] | null;
  options: Pick<RebalanceOptions, "bandBps" | "bandMaxBps">;
  /** Its next window (lib/agents/next.ts `rebalanceOutlook`), shared with its sheet's line. */
  outlook: RebalanceOutlook;
};

/** Failed runs in a row before the card says so (the executor switches the account off at eight). */
const RETRYING_AT = 3;
/** A grant this close to its end says so. */
const ENDS_SOON_SEC = 7 * 86_400;

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const date = (sec: number) => DATE.format(sec * 1000);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const names = (ids: readonly number[]) => {
  const n = ids.map((id) => EQUITIES[id].name);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : n[0];
};

/** What the card says while off and before the agents are live. */
const OFF_WORDS = ["When on, it keeps your mix on target.", "Checks once a market day, after the US open."] as const;

/** The card, or null while the Rebalancer's state loads (the view draws its frame). */
export function rebalanceCard(i: RebalanceCardInput): RebalanceCardModel | null {
  if (i.live && i.status === "loading") return null;
  const slots = (trades: readonly RebalanceTrade[]) =>
    mixSlots({ holdings: i.holdings, mixBps: i.mixBps, options: i.options, trades });
  const still = slots([]);
  const card = (
    pill: string,
    tone: PillTone,
    footer: RebalanceFooter,
    over: { faded?: boolean; slots?: MixSlot[]; say?: string } = {},
  ): RebalanceCardModel => ({
    pill: { text: pill, tone },
    faded: over.faded ?? false,
    slots: over.slots ?? still,
    footer,
    label: `Rebalance, ${pill.toLowerCase()}. ${over.say ?? (footer.kind === "words" ? footer.line1 : "")}`.trim(),
  });
  const words = (line1: string, line2: string | null = null): RebalanceFooter => ({ kind: "words", line1, line2 });
  const faded = { faded: true };

  if (!i.live) return card("Coming soon", "neutral", words(...OFF_WORDS), faded);
  // 1. JAW granted it and the executor doesn't run it yet: its registration is still to go.
  if (i.waiting || i.status === "starting")
    return card("Needs you", "needs", words("One more Face ID turns it on.", "Until then, nothing trades."), faded);
  if (i.status !== "on") {
    // 2. Stopped on its own: its year ran out, its runs kept failing, or it can no longer act on the account.
    if (i.stoppedAt !== null)
      return card("Stopped", "needs", words(`Stopped on ${date(i.stoppedAt)}. Nothing trades now.`), faded);
    // 3. Off.
    return card("Off", "neutral", words(...OFF_WORDS), faded);
  }

  const o = i.outlook;
  // The executor backs a failing account off: its next check is the first window after that.
  const checkAt = i.cooldownUntil > o.checkAt ? rebalanceCheckAt(i.cooldownUntil, i.rebalanceDay) : o.checkAt;
  const when = whenText(checkAt, i.nowSec);
  const due = o.waitsInAct ? [] : o.trades;
  const moving = slots(due);
  // 4. Runs keep failing.
  if (i.fails >= RETRYING_AT)
    return card(
      "Retrying",
      "due",
      words(`Your agents’ last ${i.fails} runs didn’t go through.`, `Nothing moved. Next check ${when}.`),
      { slots: moving },
    );
  // 5. Trades are due, and the credit is in Act: it waits.
  if (o.waitsInAct)
    return card("Paused", "neutral", words("Waits until your credit is out of Act.", "Nothing trades meanwhile."));
  // 6. Trades at the next check.
  if (due.length > 0) {
    const text = `${due.length} trade${due.length === 1 ? "" : "s"}`;
    const sells = due.filter((t) => !t.buy).map((t) => t.reserveId);
    const buys = due.filter((t) => t.buy).map((t) => t.reserveId);
    const what = [sells.length > 0 ? ` Sells ${names(sells)}.` : "", buys.length > 0 ? ` Buys ${names(buys)}.` : ""];
    return card(
      "On",
      "on",
      { kind: "trades", text, when: capital(when) },
      { slots: moving, say: `${text} ${when}.${what.join("")}` },
    );
  }
  const onTarget = o.noMix ? "No mix yet." : `On target. Checks ${when}.`;
  // 7. Its grant ends within a week.
  if (i.endsAt !== null && i.endsAt - i.nowSec <= ENDS_SOON_SEC)
    return card("Ends soon", "due", words(`Ends on ${date(i.endsAt)}. Then nothing trades.`, onTarget));
  // On, with no mix saved: nothing to keep on target yet.
  if (o.noMix) return card("On", "on", words(onTarget));
  // 8. All good.
  return card("On", "on", { kind: "on-target", next: capital(when) }, { say: `On target. Next check ${when}.` });
}

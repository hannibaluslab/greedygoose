import { mixBpsNow, startingMix, type MixHolding } from "@/lib/agents/mix";
import {
  BACKING_RULE,
  blockedWords,
  nyDay,
  rebalanceCheckAt,
  whenText,
  wholePortfolio,
  type RebalanceOutlook,
} from "@/lib/agents/next";
import {
  bandBreaks,
  bandOf,
  type BandBreak,
  type RebalanceOptions,
  type RebalanceTrade,
} from "@/lib/agents/rules/rebalance";
import { investTrades, sendToFixRaw, topUpsReady, type TopUpsState } from "@/lib/agents/rules/topUps";
import type { AgentStatus } from "@/lib/agents/status";
import { formatUsdTrim } from "@/lib/formatting";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/*
 * Rebalance's card on the Agents overview: one slot per stock in the mix, in Home's order, each with its target on top
 * and its logo placed by how far the whole portfolio's share of it (free and backing credit, Adrian 2026-10-21) sits
 * from its target, measured in its own band, so every stock reads on the same scale whatever its size. The slots of
 * the stocks the next check trades are tinted (sell red, buy green) with a ghost where the logo goes back to; those
 * trades move free stock only, so while trades or top-ups are due (waiting in Act too) the logos are placed by the free
 * stock they act on, and a SELL never sits on a logo below its line. When nothing trades and something holds it back,
 * a stock past its band is tinted the same way (over red, under green), with no ghost and no label; every other state
 * marks nothing past its band.
 * Under it, "On target" and the next check, the top-ups going in or the trades due and when, or the state's words.
 * One pill says what Rebalance itself is doing; the first state that applies wins, in the order of board 7.
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
  /**
   * Past its band while nothing trades (no `side` anywhere): "over" or "under", by the rule's own measure. The card
   * keeps it only where it says what holds the Rebalancer back (`rebalanceCard`); elsewhere it is null.
   */
  out: BandBreak;
  /**
   * Past its band with stock that backs credit, where the card says what to send (Adrian, 2026-10-22): it isn't sold,
   * so it wears the backs-credit mark instead of a sell tint. Absent elsewhere.
   */
  backs?: boolean;
};

const clamp = (x: number) => Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, x)) + 0; // + 0: never −0

/**
 * The picture's slots. With a saved mix: its stocks, each placed by its share of the mix's stock in `holdings` now
 * against its target, in its band (`bandOf`, as the rule measures it); its side comes from `trades`, since the other
 * leg of a trade can buy or sell a stock still inside its band. With no trades, a stock past its band says which way
 * (`out`, `bandBreaks`). Before a mix is saved: the stocks held now, at their share now (as the sheet opens on them),
 * all on target. Nothing saved and nothing held: the seven stocks, with no target.
 */
export function mixSlots(p: {
  holdings: readonly MixHolding[];
  mixBps: readonly number[] | null;
  options: Pick<RebalanceOptions, "bandBps" | "bandMaxBps">;
  trades: readonly RebalanceTrade[];
}): MixSlot[] {
  const mix = p.mixBps?.some((w) => w > 0) ? p.mixBps : null;
  if (!mix) {
    const held = startingMix(p.holdings, null);
    if (held.length === 0)
      return EQUITIES.map((e) => ({ reserveId: e.reserveId, targetBps: null, offset: 0, side: null, out: null }));
    return held.map((r) => ({ reserveId: r.reserveId, targetBps: r.bps, offset: 0, side: null, out: null }));
  }
  const now = mixBpsNow(p.holdings, mix);
  const sides = new Map(p.trades.map((t) => [t.reserveId, t.buy ? ("buy" as const) : ("sell" as const)]));
  const outs =
    p.trades.length === 0
      ? bandBreaks(
          EQUITIES.map((e) => {
            const h = p.holdings.find((x) => x.reserveId === e.reserveId);
            return { sharesRaw: h?.freeRaw ?? 0n, price: h?.priceRaw ?? 0n, weightBps: BigInt(mix[e.reserveId]) };
          }),
          p.options,
        )
      : null;
  return EQUITIES.filter((e) => mix[e.reserveId] > 0).map((e) => {
    const target = mix[e.reserveId];
    const band = Number(bandOf(BigInt(target), p.options));
    const drift = now ? now[e.reserveId] - target : 0;
    return {
      reserveId: e.reserveId,
      targetBps: target,
      offset: clamp(band > 0 ? drift / band : Math.sign(drift) * OFFSET_MAX),
      side: sides.get(e.reserveId) ?? null,
      out: outs?.[e.reserveId] ?? null,
    };
  });
}

/**
 * The whole portfolio as it is now, for the card while Rebalance is off (Adrian, 2026-10-20): every stock held, free
 * and backing credit, at its share of all the stock now, all on target. Rebalance trades free shares only, but while
 * it's off the card shows what the user owns. Nothing held: the seven stocks, with no target.
 */
function portfolioSlots(holdings: readonly MixHolding[]): MixSlot[] {
  return mixSlots({
    holdings: wholePortfolio(holdings),
    mixBps: null,
    options: { bandBps: 0n, bandMaxBps: 0n },
    trades: [],
  });
}

/** Up to this many stocks, the card draws its slots bigger (Adrian, 2026-10-20, board 7l). */
const BIG_MIX_MAX = 4;

/** How much bigger the card draws its slots, logos and targets: ×1.5 for 1–4 stocks, today's size for 5–7. */
export const mixScale = (count: number): number => (count <= BIG_MIX_MAX ? 1.5 : 1);

/** The pill's colours: running, neutral (off, paused, coming soon), needs the user, and a trade or a date due. */
export type PillTone = "on" | "neutral" | "needs" | "due";

export type RebalanceFooter =
  | { kind: "on-target"; next: string }
  | { kind: "trades"; text: string; when: string }
  /** Counted top-ups go into the mix at the next check ("$300 going in"). */
  | { kind: "invest"; text: string; when: string }
  | { kind: "words"; line1: string; line2: string | null };

export type RebalanceCardModel = {
  pill: { text: string; tone: PillTone };
  /** The picture at 60%: Rebalance isn't running (not live yet, needs the user, stopped, off). */
  faded: boolean;
  slots: MixSlot[];
  footer: RebalanceFooter;
  /** The whole card's name for screen readers: name, pill, then what it does now. */
  label: string;
  /** Its grant ends within a week: the sheet offers Renew whatever else it shows (Adrian, 2026-10-20). */
  endsSoon: boolean;
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
  options: RebalanceOptions;
  /** Its next window (lib/agents/next.ts `rebalanceOutlook`), shared with its sheet's line. */
  outlook: RebalanceOutlook;
  /** Top-ups, while they're on in both the account's switch and the grant it runs; null or absent otherwise. */
  topUps?: CardTopUps | null;
};

/** Top-ups as the card reads them, to work out what goes in at the next check (`investDue`). */
export type CardTopUps = {
  /** The executor's counts for the account (`topUps(account)`). */
  state: TopUpsState;
  /** Savings now, USDC units. */
  savingsRaw: bigint;
  /** What the grant's USDC limit (the buys) and its aUSDC limit (the savings withdraw) still allow, USDC units. */
  usdcLeftRaw: bigint;
  savingsLeftRaw: bigint;
};

/** Aave's rounding on a savings withdraw, which the manager charges on aUSDC (JobBase.SAVINGS_ROUNDING). */
const SAVINGS_ROUNDING = 2n;
const minOf = (...v: bigint[]) => v.reduce((a, b) => (b < a ? b : a));

/**
 * The buys that put counted top-ups into the mix at the check on New York day `day`, as GooseExecutor's RebalanceJob
 * plans them: what was counted on an earlier day (`topUpsReady`: any fall since taken out, within savings above Keep),
 * within what the grant's limits leave, once it's at least the smallest trade (`investTrades`, the contract's
 * RebalanceRules.invest). Empty when nothing goes in: the band trades go then. A day it invests, they wait a day.
 */
export function investDue(p: {
  holdings: readonly MixHolding[];
  mixBps: readonly number[];
  options: RebalanceOptions;
  topUps: CardTopUps;
  day: number;
}): RebalanceTrade[] {
  const t = p.topUps;
  const ready = topUpsReady(t.state, p.day, t.savingsRaw).readyRaw;
  const savingsLeft = t.savingsLeftRaw > SAVINGS_ROUNDING ? t.savingsLeftRaw - SAVINGS_ROUNDING : 0n;
  const amount = minOf(ready, savingsLeft, t.usdcLeftRaw);
  if (amount < p.options.minTradeRaw) return [];
  const stocks = EQUITIES.map((e) => {
    const h = p.holdings.find((x) => x.reserveId === e.reserveId);
    return {
      sharesRaw: h?.freeRaw ?? 0n,
      price: h?.priceRaw ?? 0n,
      weightBps: BigInt(p.mixBps[e.reserveId]),
      sellLeftRaw: 0n,
    };
  });
  return investTrades({ stocks }, amount, p.options);
}

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

/**
 * When it checks next. The executor backs a failing account off: its next check is the first window after that, and
 * never before the back-off ends (one that ends inside a window checks then, not at the window's open).
 */
function nextCheck(i: RebalanceCardInput): number {
  const o = i.outlook;
  return i.cooldownUntil > o.checkAt
    ? Math.max(i.cooldownUntil, rebalanceCheckAt(i.cooldownUntil, i.rebalanceDay))
    : o.checkAt;
}

/** The top-ups going in at the check at `checkAt` (`investDue`): only while they're on and a mix is saved. */
function investAt(i: RebalanceCardInput, checkAt: number): RebalanceTrade[] {
  if (!i.topUps || !i.mixBps || i.outlook.noMix) return [];
  return investDue({
    holdings: i.holdings,
    mixBps: i.mixBps,
    options: i.options,
    topUps: i.topUps,
    day: nyDay(checkAt),
  });
}

/**
 * The footer for what the next check does, and the card's words for it: top-ups going in ("$300 going in", the stocks
 * it buys), else the band trades due ("3 trades", what it sells and buys); null when it does neither.
 */
function dueFooter(
  invest: readonly RebalanceTrade[],
  trades: readonly RebalanceTrade[],
  when: string,
): { footer: RebalanceFooter; say: string } | null {
  if (invest.length > 0) {
    const text = `${formatUsdTrim(Number(invest.reduce((a, t) => a + t.amountIn, 0n)) / 10 ** USDC.decimals)} going in`;
    return {
      footer: { kind: "invest", text, when: capital(when) },
      say: `${text} ${when}. Buys ${names(invest.map((t) => t.reserveId))}.`,
    };
  }
  if (trades.length === 0) return null;
  const text = `${trades.length} trade${trades.length === 1 ? "" : "s"}`;
  const sells = trades.filter((t) => !t.buy).map((t) => t.reserveId);
  const buys = trades.filter((t) => t.buy).map((t) => t.reserveId);
  const what = [sells.length > 0 ? ` Sells ${names(sells)}.` : "", buys.length > 0 ? ` Buys ${names(buys)}.` : ""];
  return { footer: { kind: "trades", text, when: capital(when) }, say: `${text} ${when}.${what.join("")}` };
}

/** How much to send to fix the mix (`sendToFixRaw`), USDC units; null when nothing to send or no amount does it. */
function sendToFix(i: RebalanceCardInput): bigint | null {
  if (!i.mixBps) return null;
  const mix = i.mixBps;
  const stocks = EQUITIES.map((e) => {
    const h = i.holdings.find((x) => x.reserveId === e.reserveId);
    return {
      sharesRaw: h?.freeRaw ?? 0n,
      backingRaw: h?.backingRaw ?? 0n,
      price: h?.priceRaw ?? 0n,
      weightBps: BigInt(mix[e.reserveId]),
    };
  });
  const raw = sendToFixRaw(stocks, i.options);
  return raw && raw > 0n ? raw : null;
}

/** "Send $210 to fix your mix.", then why sending is the way (or that top-ups have to be on for it to go in). */
function sendWords(raw: bigint, topUpsOn: boolean): [string, string] {
  const usd = formatUsdTrim(Math.ceil(Number(raw) / 10 ** USDC.decimals));
  return [`Send ${usd} to fix your mix.`, topUpsOn ? BACKING_RULE : "Turn on top-ups so it goes in."];
}

/** What the card says while off and before the agents are live. */
const OFF_WORDS = ["When on, it keeps your mix on target.", "Checks once a market day, after the US open."] as const;

/** The card, or null while the Rebalancer's state loads (the view draws its frame). */
export function rebalanceCard(i: RebalanceCardInput): RebalanceCardModel | null {
  if (i.live && i.status === "loading") return null;
  const picture = (holdings: readonly MixHolding[], trades: readonly RebalanceTrade[]) =>
    mixSlots({ holdings, mixBps: i.mixBps, options: i.options, trades });
  // The whole portfolio against the mix, free stock and stock backing credit (Adrian, 2026-10-21): what the user owns,
  // even where Rebalance can't trade it. Before a mix is saved, the free stock its sheet opens on (`startingMix`).
  const still = picture(i.outlook.noMix ? i.holdings : wholePortfolio(i.holdings), []);
  const card = (
    pill: string,
    tone: PillTone,
    footer: RebalanceFooter,
    over: { faded?: boolean; slots?: MixSlot[]; say?: string; marks?: boolean } = {},
  ): RebalanceCardModel => ({
    pill: { text: pill, tone },
    faded: over.faded ?? false,
    // Over and under only where the card says what holds it back (`marks`), never faded: elsewhere nothing past its
    // band is on its way back (it's off, waits in Act, or keeps failing).
    slots: (over.slots ?? still).map((x) => (over.marks && !over.faded ? x : { ...x, out: null })),
    footer,
    label: `Rebalancer, ${pill.toLowerCase()}. ${over.say ?? (footer.kind === "words" ? footer.line1 : "")}`.trim(),
    endsSoon: i.endsAt !== null && i.endsAt - i.nowSec <= ENDS_SOON_SEC,
  });
  const words = (line1: string, line2: string | null = null): RebalanceFooter => ({ kind: "words", line1, line2 });
  const faded = { faded: true };

  // Off and Coming soon draw what the user owns now, not the mix: nothing keeps a mix while it's off.
  const owned = { faded: true, slots: portfolioSlots(i.holdings) };

  if (!i.live) return card("Coming soon", "neutral", words(...OFF_WORDS), owned);
  // 1. JAW granted it and the executor doesn't run it yet: its registration is still to go.
  if (i.waiting || i.status === "starting")
    return card("Needs you", "needs", words("One more Face ID turns it on.", "Until then, nothing trades."), faded);
  if (i.status !== "on") {
    // 2. Stopped on its own: its year ran out, its runs kept failing, or it can no longer act on the account.
    if (i.stoppedAt !== null)
      return card("Stopped", "needs", words(`Stopped on ${date(i.stoppedAt)}. Nothing trades now.`), faded);
    // 3. Off.
    return card("Off", "neutral", words(...OFF_WORDS), owned);
  }

  const o = i.outlook;
  const checkAt = nextCheck(i);
  const when = whenText(checkAt, i.nowSec);
  // Counted top-ups that go in at that check: the executor puts them in first, and band trades wait a day.
  const invest = investAt(i, checkAt);
  const next = invest.length > 0 ? invest : o.trades;
  const waits = next.length > 0 && o.inAct;
  // Trades and top-ups act on free stock: while some are due, the card draws the free stock they move, so each BUY,
  // SELL and ghost reads the way the trade moves it (none while they wait in Act). Nothing due: the whole portfolio.
  const moving = next.length === 0 ? still : picture(i.holdings, waits ? [] : next);
  // 4. Runs keep failing.
  if (i.fails >= RETRYING_AT)
    return card(
      "Retrying",
      "due",
      words(`Your agents’ last ${i.fails} runs didn’t go through.`, `Nothing moved. Next check ${when}.`),
      { slots: moving },
    );
  // 5. Trades or top-ups are due, and the credit is in Act: it waits.
  if (waits)
    return card("Paused", "neutral", words("Waits until your credit is out of Act.", "Nothing trades meanwhile."), {
      slots: moving,
    });
  // 6. Top-ups going into the mix at the next check, else the trades due then.
  const due = dueFooter(invest, o.trades, when);
  if (due) return card("On", "on", due.footer, { slots: moving, say: due.say });
  // Nothing trades. "On target" only while the whole portfolio sits in its band; past it, or holding none of the mix,
  // what holds Rebalance back (`blocked`): the credit (it never trades stock that backs it), every trade it would make
  // under the smallest one, what its grant still allows, or nothing of the mix to keep.
  const blocked = o.blocked && blockedWords(o.blocked, i.options.minTradeRaw, when);
  const standing = o.noMix ? "No mix yet." : blocked ? blocked[0] : `On target. Checks ${when}.`;
  // 7. Its grant ends within a week.
  if (i.endsAt !== null && i.endsAt - i.nowSec <= ENDS_SOON_SEC)
    return card("Ends soon", "due", words(`Ends on ${date(i.endsAt)}. Then nothing trades.`, standing), {
      marks: !!blocked,
    });
  // On, with no mix saved: nothing to keep on target yet.
  if (o.noMix) return card("On", "on", words(standing));
  // 8. Off target (or none of the mix held), and nothing trades: what holds it back (Adrian, 2026-10-21). Where it's the
  // stock backing credit, how much to send so today's top-ups put the whole portfolio back in its bands (2026-10-22).
  if (blocked) {
    const send = o.blocked === "credit" || o.blocked === "too-small-backing" ? sendToFix(i) : null;
    const say = send ? sendWords(send, !!i.topUps) : blocked;
    const marked = card("On", "on", words(...say), { say: say.join(" "), marks: true });
    if (!send) return marked;
    // What's sent buys the stocks under their share (still green); the ones over it back credit and aren't sold.
    const backing = (id: number) => (i.holdings.find((h) => h.reserveId === id)?.backingRaw ?? 0n) > 0n;
    return {
      ...marked,
      slots: marked.slots.map((x) => (x.out === "over" && backing(x.reserveId) ? { ...x, out: null, backs: true } : x)),
    };
  }
  // 9. All good: the whole portfolio is in its band.
  return card("On", "on", { kind: "on-target", next: capital(when) }, { say: `On target. Next check ${when}.` });
}

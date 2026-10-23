import { mixBpsNow, startingMix, type MixHolding } from "@/lib/agents/mix";
import { protectHfText } from "@/lib/agents/lines";
import {
  BACKING_RULE,
  blockedWords,
  nextRound,
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
import { investTrades, sendToFixRaw } from "@/lib/agents/rules/topUps";
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
 * Under it, "On target" and when it may next trade, the top-ups going in or the trades due and when, or the state's
 * words.
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

/**
 * One trade of the next check, as the sheet lists them one by one (Adrian, 2026-10-23), in the order GooseGuard makes
 * them: the sales first, then the buys they pay for. A sale's dollars are the least it brings (`minOut`), which is what
 * the buys spend, so the list adds up; a buy's are what it spends.
 */
export type TradeMove = { reserveId: number; side: Side; usd: number };

export const tradeMoves = (trades: readonly RebalanceTrade[]): TradeMove[] =>
  [...trades.filter((t) => !t.buy), ...trades.filter((t) => t.buy)].map((t) => ({
    reserveId: t.reserveId,
    side: t.buy ? "buy" : "sell",
    usd: Number(t.buy ? t.amountIn : t.minOut) / 10 ** USDC.decimals,
  }));

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
  /** Top-ups in the wallet go into the mix at the next round ("$300 going in"). */
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
  /** The trades or top-up buys due at the next check, one by one; empty when none is due. */
  moves: TradeMove[];
};

export type RebalanceCardInput = {
  /** The agents can be switched on (AGENTS_LIVE); until then the card says they're coming. */
  live: boolean;
  nowSec: number;
  /** The Rebalancer's state (agentStatus): "loading" draws no model, the card's frame waits for it. */
  status: AgentStatus;
  /** JAW granted it and the Guard doesn't run it yet: its registration is still to go (useAgents `toFinish`). */
  waiting: boolean;
  /** When it stopped without the user turning it off; null when it didn't. */
  stoppedAt: number | null;
  /** Its grant's end while it has one. */
  endsAt: number | null;
  /** Its moves GooseGuard refused in a row (lib/agents/feed.ts `refusedInARow`); each is tried again next round. */
  refused: number;
  holdings: readonly MixHolding[];
  mixBps: readonly number[] | null;
  options: RebalanceOptions;
  /** What it may do next (lib/agents/next.ts `rebalanceOutlook`, its pacing included), shared with its sheet's line. */
  outlook: RebalanceOutlook;
  /** Top-ups, while the account's switch is on; null or absent otherwise. */
  topUps?: CardTopUps | null;
};

/** Top-ups as the card reads them, to work out what goes in at the next round (`investDue`). */
export type CardTopUps = {
  /** The wallet's cash that goes into the mix at the next round, USDC units (the Planner's `topUpsReady`). */
  readyRaw: bigint;
};

/**
 * The buys that put the waiting top-ups into the mix at the next round (`investTrades`, the Planner's invest rule):
 * the stocks furthest below their target first. Empty when nothing waits: the band trades go then.
 */
export function investDue(p: {
  holdings: readonly MixHolding[];
  mixBps: readonly number[];
  options: RebalanceOptions;
  topUps: CardTopUps;
}): RebalanceTrade[] {
  const amount = p.topUps.readyRaw;
  if (amount <= 0n || amount < p.options.minTradeRaw) return [];
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

/** Refused moves in a row before the card says so (nothing switches itself off: each is tried again next round). */
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

/** The top-ups going in at the next round (`investDue`): only while they're on and a mix is saved. */
function investAt(i: RebalanceCardInput): RebalanceTrade[] {
  if (!i.topUps || !i.mixBps || i.outlook.noMix) return [];
  return investDue({ holdings: i.holdings, mixBps: i.mixBps, options: i.options, topUps: i.topUps });
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

/**
 * State 8 (off target, nothing trades): what holds the Rebalancer back. Where it's the stock backing credit, how much to
 * send so today's top-ups put the whole portfolio back in its bands (2026-10-22), and the over-weight stock that backs
 * credit wears the backs-credit mark instead of a sell tint: it isn't sold, what's sent buys the ones under.
 * When the free stock itself sits in its band, the Rebalancer's own work is done (Adrian, 2026-10-24: "it should be
 * considered done"): the logos sit by the free stock, and what's sent is only for the whole portfolio.
 */
function heldCard(
  i: RebalanceCardInput,
  o: RebalanceOutlook,
  blocked: [string, string],
  card: (
    pill: string,
    tone: PillTone,
    footer: RebalanceFooter,
    over: { say?: string; marks?: boolean; slots?: MixSlot[] },
  ) => RebalanceCardModel,
): RebalanceCardModel {
  const why = o.blocked;
  const send = why === "credit" ? sendToFix(i) : null;
  if (why === "credit" && o.freeOnTarget) {
    const done: [string, string] = [FREE_ON_TARGET, send ? wholeWords(send, !!i.topUps) : BACKING_RULE];
    const free = mixSlots({ holdings: i.holdings, mixBps: i.mixBps, options: i.options, trades: [] });
    return card("On", "on", { kind: "words", line1: done[0], line2: done[1] }, { say: done.join(" "), slots: free });
  }
  const say = send ? sendWords(send, !!i.topUps) : blocked;
  const marked = card("On", "on", { kind: "words", line1: say[0], line2: say[1] }, { say: say.join(" "), marks: true });
  if (!send) return marked;
  const backing = (id: number) => (i.holdings.find((h) => h.reserveId === id)?.backingRaw ?? 0n) > 0n;
  return {
    ...marked,
    slots: marked.slots.map((x) => (x.out === "over" && backing(x.reserveId) ? { ...x, out: null, backs: true } : x)),
  };
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

/** The card's first line while the free stock sits in its band and the stock backing credit holds the rest off it. */
export const FREE_ON_TARGET = "Your free stock is on target.";

/** Where the mix stands while nothing trades, for the line under "Ends soon". */
function standingWords(o: RebalanceOutlook, blocked: [string, string] | null, when: string): string {
  if (o.noMix) return "No mix yet.";
  if (o.blocked === "credit" && o.freeOnTarget) return FREE_ON_TARGET;
  return blocked ? blocked[0] : `On target. Checks ${when}.`;
}

/** What sending does then: it only brings the whole portfolio, the stock backing credit too, to the mix. */
function wholeWords(raw: bigint, topUpsOn: boolean): string {
  const usd = formatUsdTrim(Math.ceil(Number(raw) / 10 ** USDC.decimals));
  return topUpsOn
    ? `Send ${usd} to bring your whole portfolio, stock backing credit included, to your mix.`
    : `Turn on top-ups, then send ${usd} to bring your whole portfolio to your mix.`;
}

/** What the card says while off and before the agents are live. */
const OFF_WORDS = ["When on, it keeps your mix on target.", "Trades at most once a day, or on a new mix."] as const;

/** Whether what's due waits: top-ups under GooseGuard's invest line (max(1.10, Protect's own line)), trades in Act. */
const waitsNow = (o: RebalanceOutlook, due: boolean, investing: boolean) => due && (investing ? o.topUpsHeld : o.inAct);

/** Why it waits: Act, or a Protect line the user raised over it. */
const waitWords = (o: RebalanceOutlook) =>
  o.inAct
    ? "Waits until your credit is out of Act."
    : `Waits until your credit is over ${protectHfText(o.topUpsFrom)}.`;

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
    over: { faded?: boolean; slots?: MixSlot[]; say?: string; marks?: boolean; moves?: TradeMove[] } = {},
  ): RebalanceCardModel => ({
    pill: { text: pill, tone },
    faded: over.faded ?? false,
    // Over and under only where the card says what holds it back (`marks`), never faded: elsewhere nothing past its
    // band is on its way back (it's off, waits in Act, or keeps failing).
    slots: (over.slots ?? still).map((x) => (over.marks && !over.faded ? x : { ...x, out: null })),
    footer,
    label: `Rebalancer, ${pill.toLowerCase()}. ${over.say ?? (footer.kind === "words" ? footer.line1 : "")}`.trim(),
    endsSoon: i.endsAt !== null && i.endsAt - i.nowSec <= ENDS_SOON_SEC,
    moves: over.moves ?? [],
  });
  const words = (line1: string, line2: string | null = null): RebalanceFooter => ({ kind: "words", line1, line2 });
  const faded = { faded: true };

  // Off and Coming soon draw what the user owns now, not the mix: nothing keeps a mix while it's off.
  const owned = { faded: true, slots: portfolioSlots(i.holdings) };

  if (!i.live) return card("Coming soon", "neutral", words(...OFF_WORDS), owned);
  // 1. JAW granted it and the Guard doesn't run it yet: its registration is still to go.
  if (i.waiting || i.status === "starting")
    return card("Needs you", "needs", words("One more Face ID turns it on.", "Until then, nothing trades."), faded);
  if (i.status !== "on") {
    // 2. Stopped on its own: its year ran out.
    if (i.stoppedAt !== null)
      return card("Stopped", "needs", words(`Stopped on ${date(i.stoppedAt)}. Nothing trades now.`), faded);
    // 3. Off.
    return card("Off", "neutral", words(...OFF_WORDS), owned);
  }

  const o = i.outlook;
  // Top-ups waiting in the wallet go in at the next round, never held back (decision 4), before any band trade; band
  // trades go when the pacing lets them (`rebalanceCheckAt`).
  const invest = investAt(i);
  const next = invest.length > 0 ? invest : o.trades;
  const when = whenText(invest.length > 0 ? nextRound(i.nowSec) : o.checkAt, i.nowSec);
  const waits = waitsNow(o, next.length > 0, invest.length > 0);
  // Trades and top-ups act on free stock: while some are due, the card draws the free stock they move, so each BUY,
  // SELL and ghost reads the way the trade moves it (none while they wait in Act). Nothing due: the whole portfolio.
  const moving = next.length === 0 ? still : picture(i.holdings, waits ? [] : next);
  // 4. Its moves keep being refused: each is tried again at the next round.
  if (i.refused >= RETRYING_AT)
    return card(
      "Retrying",
      "due",
      words(`Your agents’ last ${i.refused} runs didn’t go through.`, `Nothing moved. Next check ${when}.`),
      { slots: moving },
    );
  // 5. Trades or top-ups are due, and the credit is in Act: it waits.
  if (waits) return card("Paused", "neutral", words(waitWords(o), "Nothing trades meanwhile."), { slots: moving });
  // 6. Top-ups going into the mix at the next round, else the trades due when the pacing lets them.
  const due = dueFooter(invest, o.trades, when);
  if (due) return card("On", "on", due.footer, { slots: moving, say: due.say, moves: tradeMoves(next) });
  // Nothing trades. "On target" only while the whole portfolio sits in its band; past it, or holding none of the mix,
  // what holds Rebalance back (`blocked`): the credit (it never trades stock that backs it), no trade it can make, or
  // nothing of the mix to keep.
  const blocked = o.blocked && blockedWords(o.blocked, when);
  // Only the stock backing credit holds the whole portfolio off its mix: the free stock, all it trades, is done.
  const freeDone = o.blocked === "credit" && o.freeOnTarget;
  const standing = standingWords(o, blocked, when);
  // 7. Its grant ends within a week.
  if (i.endsAt !== null && i.endsAt - i.nowSec <= ENDS_SOON_SEC)
    return card(
      "Ends soon",
      "due",
      words(`Ends on ${date(i.endsAt)}. Then nothing trades.`, standing),
      freeDone ? { slots: picture(i.holdings, []) } : { marks: !!blocked },
    );
  // On, with no mix saved: nothing to keep on target yet.
  if (o.noMix) return card("On", "on", words(standing));
  // 8. Off target (or none of the mix held), and nothing trades: what holds it back (Adrian, 2026-10-21). Where it's the
  // stock backing credit, how much to send so today's top-ups put the whole portfolio back in its bands (2026-10-22).
  if (blocked) return heldCard(i, o, blocked, card);
  // 9. All good: the whole portfolio is in its band.
  return card("On", "on", { kind: "on-target", next: capital(when) }, { say: `On target. Next check ${when}.` });
}

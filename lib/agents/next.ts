import { CASH_AGENT, RISK } from "@/config/risk";
import { protectHfText } from "@/lib/agents/lines";
import { OFF_REASONS } from "@/lib/agents/events";
import { OFF_WHY } from "@/lib/agents/feed";
import { agentOf, AGENTS, type ActCard, type Agent, type Next, type WeekendCard } from "@/lib/agents/list";
import { isMix, previewTrades, type MixHolding } from "@/lib/agents/mix";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";
import { planProtect, weekendHeadsUp } from "@/lib/agents/rules/protect";
import { bandBreaks, type RebalanceOptions, type RebalanceTrade } from "@/lib/agents/rules/rebalance";
import { clockText, dayIn, weekdayText } from "@/lib/clock";
import { formatUsdTrim } from "@/lib/formatting";
import { STATUS_LABEL, statusFor } from "@/lib/risk/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/*
 * What each agent does next. With a Planner configured, its `planOf(account)` names the first job, in its order, with
 * a move; every other agent reads its TypeScript rule (lib/agents/rules/*.ts) on live data. With none configured, every
 * agent reads its rule. Save and Entry have no agent on screen (D20), so a plan for them gives no line.
 */

const usd = (raw: bigint) => formatUsdTrim(Number(raw) / 10 ** USDC.decimals);
const move = (will: string, would: string): Next => ({ will, would });

/** The numbers the rules take (GoosePlanner's views and the account's own Protect line, D18); config/risk.ts mirrors the defaults. */
export type RuleNumbers = {
  minRepayRaw: bigint;
  triggerHf: number;
  targetHf: number;
  stressDrop: number;
  stressFloorHf: number;
  /** How long before a price freeze the weekend card shows, in seconds (the Planner's `amounts`). */
  weekendWindowSec: number;
  rebalance: RebalanceOptions;
};

const raw = (usdAmount: number) => BigInt(Math.round(usdAmount * 10 ** USDC.decimals));

/** The defaults, for when no Planner is configured. */
export function defaultNumbers(rebalance: RebalanceOptions): RuleNumbers {
  return {
    minRepayRaw: raw(CASH_AGENT.minRepayUsd),
    triggerHf: CASH_AGENT.triggerHf,
    targetHf: CASH_AGENT.targetHf,
    stressDrop: CASH_AGENT.stressDrop,
    stressFloorHf: CASH_AGENT.stressFloorHf,
    weekendWindowSec: CASH_AGENT.weekendWindowSec,
    rebalance,
  };
}

/** GoosePlanner's `planOf(account)`: what a round would do for the account now (today's Plan layout). */
export type Plan = { action: number; job: number; amount: bigint; reason: number; off: number };

/** The Planner's Action, in order (GooseExecutor's, kept for the app). */
const ACTIONS = [
  "none",
  "prune",
  "repay",
  "save",
  "sell",
  "end-rescue",
  "defer",
  "rebalance",
  "convert",
  "refresh",
] as const;

/**
 * The plan's move in words, and the agent it's for; null when a run would do nothing, when it's a job with no agent on
 * screen (Save's and Entry's moves, D20), or when it only ends a rescue or refreshes Aave's collateral settings (no
 * money moves, so the agent's own rule says where the credit stands).
 */
export function planNext(p: Plan): { agent: Agent; next: Next } | null {
  const job: AgentJob | undefined = JOBS[p.job];
  const agent = job ? agentOf(job) : null;
  const action = ACTIONS[p.action];
  if (!agent || !action || ["none", "save", "convert", "end-rescue", "refresh"].includes(action)) return null;
  const a = usd(p.amount);
  const next: Next =
    action === "prune"
      ? { idle: `Stopping${OFF_WHY[OFF_REASONS[p.off] ?? "revoked"]}` }
      : action === "repay"
        ? move(`repays ${a} from your cash`, `Would repay ${a} from your cash`)
        : action === "sell"
          ? move(`sells backing stock to repay ${a}`, `Would sell backing stock to repay ${a}`)
          : action === "defer"
            ? move("finishes its last move", "Would finish its last move")
            : move(`trades ${a}`, `Would trade ${a}`);
  return { agent, next };
}

/** KeeperHub's round: every 10 minutes, on the clock's tens (workflow q5vdv47dieyabhg4toiue). */
const ROUND_SEC = 600;

/** The first round after `sec`: when the agents next look at the account. */
export const nextRound = (sec: number): number => (Math.floor(sec / ROUND_SEC) + 1) * ROUND_SEC;

/**
 * GooseGuard's Rebalance pacing (decision 4): a rebalance that sells runs in one session of an hour, then waits 20 hours
 * from when that session opened, unless the user sets a new mix. Top-ups going in are never held back.
 */
export const REBALANCE_SESSION_SEC = 3_600;
export const REBALANCE_GAP_SEC = 20 * 3_600;

/** What the pacing reads from GooseGuard's `accountOf`: when the last session opened and when the mix was last set. */
type Pacing = { sessionAt: number; mixSetAt: number };

/**
 * When the Rebalancer may next trade the mix: the next round while a session is open (and that round is still in it),
 * once its 20-hour wait is over, or once the user set a new mix since the session opened; else the first round after
 * the wait ends. No calendar: it trades weekends too (decision 7).
 */
export function rebalanceCheckAt(nowSec: number, pacing: Pacing): number {
  const { sessionAt, mixSetAt } = pacing;
  const round = nextRound(nowSec);
  const fresh = mixSetAt > sessionAt || round >= sessionAt + REBALANCE_GAP_SEC;
  if (fresh || round < sessionAt + REBALANCE_SESSION_SEC) return round;
  return nextRound(sessionAt + REBALANCE_GAP_SEC - 1);
}

/**
 * "today 5 PM GMT+3", "tomorrow 5 PM GMT+3", "Mon 5 PM GMT+3": the viewer's own clock and its GMT offset
 * (Adrian, 2026-10-21), "GMT" alone for a viewer on GMT. `timeZone` pins a zone for the tests.
 */
export function whenText(sec: number, nowSec: number, timeZone?: string): string {
  const days = dayIn(sec, timeZone) - dayIn(nowSec, timeZone);
  const day = days <= 0 ? "today" : days === 1 ? "tomorrow" : weekdayText(sec, timeZone);
  return `${day} ${clockText(sec, timeZone)}`;
}

/** "tomorrow at 5 PM GMT+3", "Mon at 5 PM GMT+3": whenText with "at" after the day (always one word), in a sentence. */
export const atText = (sec: number, nowSec: number, timeZone?: string): string =>
  whenText(sec, nowSec, timeZone).replace(" ", " at ");

/** What the rules read off the account and the chain. */
export type NextInput = {
  nowSec: number;
  /** Savings (Aave V3), USDC units: the cash Protect repays from. */
  savingsRaw: bigint;
  totalBackingUsd: number;
  avgCf: number;
  debtUsd: number;
  /** Free shares and Aave's price, by reserve id. */
  holdings: readonly MixHolding[];
  /** The account's mix in BPS, by reserve id; null before one is saved (or read). */
  mixBps: readonly number[] | null;
  numbers: RuleNumbers;
  /** The Rebalancer's pacing (GooseGuard's `accountOf`). */
  pacing: Pacing;
  /** A rescue Protect started is under way (the Guard's `rescueAt` isn't 0): it goes on until the target. */
  rescuing: boolean;
  /** Protect may sell backing stock (its sell grant is on or starting). */
  sellOn: boolean;
  plan: Plan | null;
};

/**
 * Protect (planProtect; Protect's line, Adrian 2026-10-19): repays from the cash below its line, and on through a
 * rescue until the target. Above its line it says where it steps in (Act is a warning only). With no cash left, a sale
 * follows when selling is on, weekends included (decision 7: whenever Aave and the 1% price check allow). No amount
 * limit (decision 9).
 */
function protectNext(i: NextInput): Next {
  const d = planProtect({
    totalBackingUsd: i.totalBackingUsd,
    avgCf: i.avgCf,
    debtUsd: i.debtUsd,
    savingsUsd: Number(i.savingsRaw) / 10 ** USDC.decimals,
    capLeftUsd: Infinity,
    triggerHf: i.numbers.triggerHf,
    targetHf: i.numbers.targetHf,
    rescuing: i.rescuing,
    minRepayUsd: Number(i.numbers.minRepayRaw) / 10 ** USDC.decimals,
  });
  if (d.action === "repay") {
    const a = formatUsdTrim(Math.ceil(d.amountUsd * 100) / 100);
    return move(`repays ${a} from your cash`, `Would repay ${a} from your cash`);
  }
  if (d.reason === "no-debt") return { idle: "Nothing owed, nothing to do." };
  const status = statusFor(d.hf);
  const label = STATUS_LABEL[status];
  if (d.reason === "healthy") {
    return {
      idle:
        status === "safe"
          ? "Safe. Nothing to do."
          : `${label}. Protector steps in at ${protectHfText(i.numbers.triggerHf)}`,
    };
  }
  if (!i.sellOn) return { idle: `${label}. No cash to repay with` };
  return move("sells backing stock to repay", "Would sell backing stock to repay");
}

/**
 * The Act warning (Adrian, 2026-10-19): a plain health check, credit owing in Act (Aave's health factor under
 * RISK.watchMin, as the status shows it). With Protect on it stops at Protect's line, where Protect itself acts; with
 * Protect off nothing acts, so it warns all the way down. A card only, with what repaying brings the credit back to
 * Protect's target, in Watch, rounded up so it's enough. The push for the same warning is sent by the runner, outside
 * this repo.
 */
export function actWarning(i: {
  /** Aave's health factor; null when nothing is owed. */
  healthFactor: number | null;
  totalBackingUsd: number;
  avgCf: number;
  debtUsd: number;
  numbers: Pick<RuleNumbers, "triggerHf" | "targetHf">;
  protectOn: boolean;
}): ActCard | null {
  const hf = i.healthFactor;
  if (hf === null || i.debtUsd <= 0 || hf >= RISK.watchMin || (i.protectOn && hf < i.numbers.triggerHf)) return null;
  // Whole dollars, rounded up; a millionth of a dollar of floating-point dust doesn't add one.
  const addUsd = Math.ceil(i.debtUsd - (i.totalBackingUsd * i.avgCf) / i.numbers.targetHf - 1e-6);
  return addUsd > 0
    ? { addUsd, protectOn: i.protectOn, protect: { line: i.numbers.triggerHf, target: i.numbers.targetHf } }
    : null;
}

/**
 * The weekend card (lib/agents/rules/protect.ts `weekendHeadsUp`, on the live numbers): in the window before Aave's
 * stock prices next pause, credit that the stress drop at the reopen would take under Aave's line. No move: a card
 * only, and it never says the agents stop (decision 7: they act whenever Aave and the 1% price check allow).
 * `freezeAt` is the Planner's `nextFreeze`, its New York calendar with the holidays it holds, so the card shows before
 * a pause that starts mid-week and not while prices are already held (Good Friday); null while it isn't read.
 */
export function weekendCard(
  i: Pick<NextInput, "nowSec" | "totalBackingUsd" | "avgCf" | "debtUsd" | "numbers"> & { freezeAt: number | null },
): WeekendCard | null {
  const h = weekendHeadsUp({
    totalBackingUsd: i.totalBackingUsd,
    avgCf: i.avgCf,
    debtUsd: i.debtUsd,
    weekendWindow: beforeFreeze(i.nowSec, i.freezeAt, i.numbers.weekendWindowSec),
    triggerHf: i.numbers.triggerHf,
    targetHf: i.numbers.targetHf,
    stressDrop: i.numbers.stressDrop,
    stressFloorHf: i.numbers.stressFloorHf,
  });
  if (!h || i.freezeAt === null) return null;
  return {
    addUsd: Math.ceil(h.addUsd),
    dropPct: Math.round(i.numbers.stressDrop * 100),
    // The freeze is Friday 8 PM New York: Saturday already on a clock east of it, so the day is said too.
    when: atText(i.freezeAt, i.nowSec),
  };
}

/**
 * Whether `nowSec` is in the window before a freeze: prices still live, and the next freeze starts within `windowSec`.
 * It agrees with Leo's `inWeekendWindow` on a week with no holiday (contracts/test/NyCalendar.t.sol).
 */
export function beforeFreeze(nowSec: number, freezeAt: number | null, windowSec: number): boolean {
  return freezeAt !== null && freezeAt > nowSec && freezeAt - nowSec <= windowSec;
}

/** What the Rebalancer's outlook reads: NextInput's own fields. */
export type OutlookInput = Pick<
  NextInput,
  "nowSec" | "holdings" | "mixBps" | "pacing" | "debtUsd" | "totalBackingUsd" | "avgCf"
> & {
  /** `triggerHf`: Protect's own line, which holds top-ups back above Act (the default 1.03 when absent). */
  numbers: Pick<RuleNumbers, "rebalance"> & Partial<Pick<RuleNumbers, "triggerHf">>;
};

/**
 * What the Rebalancer does when it may next trade, for its sheet's line and its card: whether a mix is saved, the
 * trades its rule finds for it on today's free shares, when it may next trade (its pacing, `rebalanceCheckAt`), and
 * whether it waits because the credit is in Act.
 * And the whole portfolio's place against the mix (Adrian, 2026-10-21): "On target" only while all of it, the stock
 * backing credit too, sits inside its band and holds some of the mix; when it doesn't and nothing trades, what holds
 * the Rebalancer back (`blocked`).
 */
export type RebalanceOutlook = {
  noMix: boolean;
  trades: RebalanceTrade[];
  checkAt: number;
  /** The credit is in Act now: the trades wait (the Planner trades only from 1.10). */
  inAct: boolean;
  /** Top-ups wait: GooseGuard invests only from health max(1.10, Protect's line), `topUpsFrom`. */
  topUpsHeld: boolean;
  topUpsFrom: number;
  /** Trades are due, and the credit is in Act: the Rebalancer waits. */
  waitsInAct: boolean;
  /** The whole portfolio (free stock and stock backing credit) breaks the mix's band, by the rule's own measure. */
  offTarget: boolean;
  /**
   * Why nothing trades though the mix isn't kept: the whole portfolio is off target, or holds none of the mix. Null
   * when it trades, when the whole portfolio sits in its band, or when no mix is saved.
   */
  blocked: RebalanceBlock | null;
  /**
   * The free stock holds some of the mix and sits inside its band: what the Rebalancer can trade is done, whatever
   * the stock backing credit does to the whole portfolio (Adrian, 2026-10-24).
   */
  freeOnTarget: boolean;
};

/**
 * What holds the Rebalancer back while nothing trades (Adrian, 2026-10-21):
 * - "credit": the rule would trade if the stock backing credit were free (it never trades stock that backs it);
 * - "no-trade": even with all of it free, the rule finds no trade it can make (a stock with no price, a trade so small
 *   its floor rounds to nothing);
 * - "none-held": the whole portfolio holds none of the mix, so there is nothing to keep on target.
 */
type RebalanceBlock = "credit" | "no-trade" | "none-held";

/** Every stock as if none of it backed credit: free shares plus the shares backing credit. */
export const wholePortfolio = (holdings: readonly MixHolding[]): MixHolding[] =>
  holdings.map((h) => ({ ...h, freeRaw: h.freeRaw + (h.backingRaw ?? 0n) }));

export function rebalanceOutlook(i: OutlookInput): RebalanceOutlook {
  const checkAt = rebalanceCheckAt(i.nowSec, i.pacing);
  // The Rebalancer waits while the credit is in Act: the status line (GooseGuard's invest health, 1.10), not
  // Protect's, which acts further down (Adrian, 2026-10-19).
  const hf = i.debtUsd > 0 ? (i.totalBackingUsd * i.avgCf) / i.debtUsd : Infinity;
  const inAct = hf < RISK.watchMin;
  const topUpsFrom = Math.max(RISK.watchMin, i.numbers.triggerHf ?? CASH_AGENT.triggerHf);
  const held = { topUpsHeld: hf < topUpsFrom, topUpsFrom };
  if (!i.mixBps || !isMix(i.mixBps) || i.mixBps.every((w) => w === 0))
    return {
      noMix: true,
      trades: [],
      checkAt,
      inAct,
      ...held,
      waitsInAct: false,
      offTarget: false,
      blocked: null,
      freeOnTarget: false,
    };
  const mixBps = i.mixBps;
  const tradesOn = (holdings: readonly MixHolding[]) =>
    previewTrades({
      holdings,
      rows: EQUITIES.map((e) => ({ reserveId: e.reserveId, bps: mixBps[e.reserveId] })),
      options: i.numbers.rebalance,
    });
  const trades = tradesOn(i.holdings);
  const whole = wholePortfolio(i.holdings);
  const book = (holdings: readonly MixHolding[]) =>
    EQUITIES.map((e) => {
      const h = holdings.find((x) => x.reserveId === e.reserveId);
      return { sharesRaw: h?.freeRaw ?? 0n, price: h?.priceRaw ?? 0n, weightBps: BigInt(mixBps[e.reserveId]) };
    });
  // The mix's stock at Aave's price, as the rule values it: only the stocks in the mix count.
  const mixValue = (holdings: readonly MixHolding[]) =>
    book(holdings).reduce((a, s) => a + (s.weightBps > 0n ? (s.sharesRaw * s.price) / 10n ** 10n : 0n), 0n);
  const offTarget = bandBreaks(book(whole), i.numbers.rebalance).some((b) => b !== null);
  const blocked: RebalanceBlock | null =
    trades.length > 0
      ? null
      : mixValue(whole) === 0n
        ? "none-held"
        : !offTarget
          ? null
          : tradesOn(whole).length > 0
            ? "credit"
            : "no-trade";
  const freeOnTarget =
    mixValue(i.holdings) > 0n && bandBreaks(book(i.holdings), i.numbers.rebalance).every((b) => b === null);
  return {
    noMix: false,
    trades,
    checkAt,
    inAct,
    ...held,
    waitsInAct: trades.length > 0 && inAct,
    offTarget,
    blocked,
    freeOnTarget,
  };
}

/** The Rebalancer's rule, said wherever credit is what holds it (its sheet always says it). */
export const BACKING_RULE = "Stock that backs your credit isn’t rebalanced.";

/**
 * The card's two lines for what holds the Rebalancer back (`RebalanceBlock`), its sheet's line after them; the first
 * is the Agents list's line too. `when` is the next check (whenText).
 */
export function blockedWords(b: RebalanceBlock, when: string): [string, string] {
  switch (b) {
    case "credit":
      // Freeing up is what takes stock out of backing; the Repay sheet asks for a repay first when one is needed.
      return [BACKING_RULE, "Free up some to let it trade."];
    case "no-trade":
      return ["Off target, but nothing it can trade now.", `Next check ${when}.`];
    case "none-held":
      return ["You hold none of your mix yet.", "Buy some and it keeps them on target."];
  }
}

/** Rebalance: the trades its rule finds for the saved mix on today's free shares, when its pacing next lets it trade. */
function rebalanceNext(i: NextInput): Next {
  const o = rebalanceOutlook(i);
  if (o.noMix) return { idle: "No mix yet" };
  const when = whenText(o.checkAt, i.nowSec);
  if (o.blocked === "credit" && o.freeOnTarget) return { idle: `Free stock on target. Checks ${when}` };
  if (o.blocked) return { idle: blockedWords(o.blocked, when)[0].replace(/\.$/, "") };
  if (o.trades.length === 0) return { idle: `On target. Checks ${when}` };
  if (o.waitsInAct) return { idle: "Waits until your credit is out of Act" };
  const spend = usd(o.trades.filter((t) => t.buy).reduce((a, t) => a + t.amountIn, 0n));
  return move(`trades ${spend} ${when}`, `Would trade ${spend}`);
}

const RULES: Record<Agent, (i: NextInput) => Next> = {
  protect: protectNext,
  rebalance: rebalanceNext,
};

/** Every agent's next line: the Planner's plan for the agent it names, each agent's own rule for the rest. */
export function agentNexts(i: NextInput): Record<Agent, Next> {
  const planned = i.plan && planNext(i.plan);
  return Object.fromEntries(AGENTS.map((a) => [a, planned?.agent === a ? planned.next : RULES[a](i)])) as Record<
    Agent,
    Next
  >;
}

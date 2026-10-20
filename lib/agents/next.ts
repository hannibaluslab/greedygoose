import { CASH_AGENT, RISK } from "@/config/risk";
import { OFF_REASONS } from "@/lib/agents/events";
import { OFF_WHY } from "@/lib/agents/feed";
import {
  agentOf,
  AGENTS,
  hfText,
  timeText,
  type ActCard,
  type Agent,
  type Next,
  type WeekendCard,
} from "@/lib/agents/list";
import { isMix, previewTrades, type MixHolding } from "@/lib/agents/mix";
import { JOBS, readStockLimits, type AgentJob } from "@/lib/agents/permissions";
import { planProtect, weekendHeadsUp } from "@/lib/agents/rules/protect";
import type { RebalanceOptions, RebalanceTrade } from "@/lib/agents/rules/rebalance";
import { formatUsdTrim } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { STATUS_LABEL, statusFor } from "@/lib/risk/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/*
 * What each agent does next. With an executor configured, its `planOf(account)` names the first job, in its order,
 * with a move; every other agent reads its TypeScript rule (lib/agents/rules/*.ts, which the contract matches through the
 * differential tests) on live data. With none configured, every agent reads its rule. Save and Entry have no agent on
 * screen (D20), so a plan for them gives no line.
 */

const usd = (raw: bigint) => formatUsdTrim(Number(raw) / 10 ** USDC.decimals);
const move = (will: string, would: string): Next => ({ will, would });

/** The executor's numbers the rules take (its registry, D18); config/risk.ts mirrors its deploy defaults. */
export type RuleNumbers = {
  minRepayRaw: bigint;
  triggerHf: number;
  targetHf: number;
  stressDrop: number;
  stressFloorHf: number;
  /** How long before a price freeze the weekend card shows, in seconds (the executor's `amounts`). */
  weekendWindowSec: number;
  rebalance: RebalanceOptions;
};

const raw = (usdAmount: number) => BigInt(Math.round(usdAmount * 10 ** USDC.decimals));

/** The deploy defaults, for when no executor is configured. */
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

/** GooseExecutor's `planOf(account)`: what a run would do for the account now. */
export type Plan = { action: number; job: number; amount: bigint; reason: number; off: number };

/** GooseExecutor's Action, in order. */
const ACTIONS = ["none", "prune", "repay", "save", "sell", "end-rescue", "defer", "rebalance", "convert"] as const;

/**
 * The plan's move in words, and the agent it's for; null when a run would do nothing, when it's a job with no agent on
 * screen (Save's and Entry's moves, D20), or when it only ends a rescue that reached its target (no money moves, so
 * the agent's own rule says where the credit stands).
 */
export function planNext(p: Plan): { agent: Agent; next: Next } | null {
  const job: AgentJob | undefined = JOBS[p.job];
  const agent = job ? agentOf(job) : null;
  const action = ACTIONS[p.action];
  if (!agent || !action || ["none", "save", "convert", "end-rescue"].includes(action)) return null;
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

/** New York's calendar day of `sec`, counted from 1970-01-01, as GooseExecutor's NyCalendar.day counts it. */
export function nyDay(sec: number): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const p = Object.fromEntries(f.formatToParts(sec * 1000).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000;
}

/** The second `hour`:00 New York time falls on, on New York day `day`. */
function nyHour(day: number, hour: number): number {
  const est = day * 86_400 + (hour + 5) * 3_600;
  const shown = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(
      est * 1000,
    ),
  );
  return shown === hour ? est : est - 3_600; // daylight time: New York is 4 hours behind
}

/** The Rebalancer's window: 10:00 to 10:30 New York, once a market day (GooseExecutor's RebalanceJob). */
const WINDOW = { hour: 10, minutes: 30 } as const;

/**
 * When the Rebalancer next looks at the mix: 10:00 New York on the next weekday whose window hasn't passed and on
 * which it hasn't traded yet (`ranDay`, the registry's rebalanceDay), never before New York day `notBefore` (a top-up
 * counted today goes in on a later day). Holidays are the executor's own calendar.
 */
export function rebalanceCheckAt(nowSec: number, ranDay: number, notBefore = 0): number {
  for (let d = Math.max(nyDay(nowSec), notBefore); ; d++) {
    const weekday = new Date(d * 86_400_000).getUTCDay();
    const opens = nyHour(d, WINDOW.hour);
    if (weekday === 0 || weekday === 6 || d === ranDay || nowSec >= opens + WINDOW.minutes * 60) continue;
    return opens;
  }
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** "today 10:00 AM", "tomorrow 10:00 AM", "Mon 10:00 AM", in the viewer's own time. */
export function whenText(sec: number, nowSec: number): string {
  const days = Math.round((midnight(sec * 1000) - midnight(nowSec * 1000)) / 86_400_000);
  const day = days <= 0 ? "today" : days === 1 ? "tomorrow" : WEEKDAY.format(sec * 1000);
  return `${day} ${TIME.format(sec * 1000)}`;
}

/** What one of a grant's spend limits still allows in its current period, in the token's own units. */
export type SpendLeft = { token: string; leftRaw: bigint };

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
  /** The registry's mix in BPS, by reserve id; null before one is saved (or read). */
  mixBps: readonly number[] | null;
  /**
   * What each job's limit still allows now, one figure per spend of its grant (GooseExecutor's `permissionOf`, the
   * manager's `getCurrentPeriod`); null while it has none registered, so the rule runs on a fresh period at `capRaw`.
   */
  left: Readonly<Record<AgentJob, readonly SpendLeft[] | null>>;
  /** The limit each rule assumes: the grant's, or the one the job starts on. USDC units. */
  capRaw: Readonly<Record<AgentJob, bigint>>;
  capMaxRaw: bigint | null;
  numbers: RuleNumbers;
  /** The New York day the Rebalancer last traded (the registry's `accounts`). */
  rebalanceDay: number;
  /** A rescue Protect started is under way (the registry's `rescueAt` isn't 0): it goes on until the target. */
  rescuing: boolean;
  /** Protect may sell backing stock (its sell grant is on or starting). */
  sellOn: boolean;
  /** Stock prices are held now (a weekend or a holiday): Protect never sells then. */
  pricesHeld: boolean;
  plan: Plan | null;
};

const smaller = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Protect (planProtect; Protect's line, Adrian 2026-10-19): repays from savings below its line, and on through a rescue
 * until the target, back in Watch. Above its line it says where it steps in (Act is a warning only). With no cash left,
 * a sale follows when selling is on, never while prices are held. No amount limit: the grant is at CAP_MAX, so a
 * limit that is used up can only be a capped test deploy's, and Protect goes on at its next run.
 */
function protectNext(i: NextInput): Next {
  const left = i.left.protect;
  const d = planProtect({
    totalBackingUsd: i.totalBackingUsd,
    avgCf: i.avgCf,
    debtUsd: i.debtUsd,
    savingsUsd: Number(i.savingsRaw) / 10 ** USDC.decimals,
    capLeftUsd: Number(left ? left.map((s) => s.leftRaw).reduce(smaller) : i.capRaw.protect) / 10 ** USDC.decimals,
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
      idle: status === "safe" ? "Safe. Nothing to do." : `${label}. Protect steps in at ${hfText(i.numbers.triggerHf)}`,
    };
  }
  if (d.reason === "too-small") return { idle: `${label}. Nothing worth repaying yet` };
  if (d.reason === "no-cap") return { idle: `${label}. Repays on its next run` };
  if (!i.sellOn) return { idle: `${label}. No cash to repay with` };
  if (i.pricesHeld) return { idle: `${label}. Sells backing stock when prices reopen` };
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
  return addUsd > 0 ? { addUsd, protectOn: i.protectOn } : null;
}

/**
 * The weekend card (lib/agents/rules/protect.ts `weekendHeadsUp`, on the executor's live numbers): in the window
 * before the next price freeze, credit that the stress drop would take under Aave's line. No move: a card only.
 * `freezeAt` is the executor's `nextFreeze`, its own calendar with the holidays it holds, so the card shows before a
 * freeze that starts mid-week and not while prices are already held (Good Friday); null while it isn't read.
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
    when: `at ${timeText(i.freezeAt)}`,
  };
}

/**
 * Whether `nowSec` is in the window before a freeze: prices still live, and the next freeze starts within `windowSec`.
 * The executor's own test of it (ExecutorHarness.preFreeze) agrees with Leo's `inWeekendWindow` on a week with no
 * holiday (contracts/test/NyCalendar.t.sol).
 */
export function beforeFreeze(nowSec: number, freezeAt: number | null, windowSec: number): boolean {
  return freezeAt !== null && freezeAt > nowSec && freezeAt - nowSec <= windowSec;
}

/**
 * Whether stock prices are held at `nowSec`: the executor's own calendar gives the time asked itself as the next freeze
 * while they are (`nextFreeze`, holidays included). Until it's read, the weekend's hours (`marketState`).
 */
export function pricesHeldAt(nowSec: number, freezeAt: number | null): boolean {
  return freezeAt !== null ? freezeAt <= nowSec : !marketState(new Date(nowSec * 1000)).open;
}

/** What the Rebalancer's outlook reads: NextInput's own fields, the Rebalancer's alone where they're kept by job. */
export type OutlookInput = Pick<
  NextInput,
  "nowSec" | "holdings" | "mixBps" | "capMaxRaw" | "rebalanceDay" | "debtUsd" | "totalBackingUsd" | "avgCf"
> & {
  left: Pick<NextInput["left"], "rebalance">;
  capRaw: Pick<NextInput["capRaw"], "rebalance">;
  numbers: Pick<RuleNumbers, "rebalance">;
};

/**
 * What the Rebalancer does at its next window, for its sheet's line and its card: whether a mix is saved, the trades
 * its rule finds for it on today's free shares, when it looks next, and whether it waits because the credit is in Act.
 */
export type RebalanceOutlook = {
  noMix: boolean;
  trades: RebalanceTrade[];
  checkAt: number;
  /** Trades are due, and the credit is in Act: GooseExecutor's RebalanceJob waits. */
  waitsInAct: boolean;
};

export function rebalanceOutlook(i: OutlookInput): RebalanceOutlook {
  const checkAt = rebalanceCheckAt(i.nowSec, i.rebalanceDay);
  if (!i.mixBps || !isMix(i.mixBps) || i.mixBps.every((w) => w === 0))
    return { noMix: true, trades: [], checkAt, waitsInAct: false };
  const left = i.left.rebalance;
  const trades = previewTrades({
    holdings: i.holdings,
    rows: EQUITIES.map((e) => ({ reserveId: e.reserveId, bps: i.mixBps![e.reserveId] })),
    capRaw: i.capRaw.rebalance,
    capMaxRaw: i.capMaxRaw,
    options: i.numbers.rebalance,
    left: left
      ? {
          usdcRaw: left[0].leftRaw,
          stocksRaw:
            readStockLimits(
              "rebalance",
              left.map((s) => ({ token: s.token, allowance: s.leftRaw })),
            ) ?? EQUITIES.map(() => 0n),
        }
      : undefined,
  });
  // GooseExecutor's RebalanceJob waits while the credit is in Act: the status line (RebalanceJob.ACT_HF), not
  // Protect's, which acts further down (Adrian, 2026-10-19).
  const hf = i.debtUsd > 0 ? (i.totalBackingUsd * i.avgCf) / i.debtUsd : Infinity;
  return { noMix: false, trades, checkAt, waitsInAct: trades.length > 0 && hf < RISK.watchMin };
}

/** Rebalance: the trades its rule finds for the saved mix on today's free shares, at the next window. */
function rebalanceNext(i: NextInput): Next {
  const o = rebalanceOutlook(i);
  if (o.noMix) return { idle: "No mix yet" };
  const when = whenText(o.checkAt, i.nowSec);
  if (o.trades.length === 0) return { idle: `On target. Checks ${when}` };
  if (o.waitsInAct) return { idle: "Waits until your credit is out of Act" };
  const spend = usd(o.trades.filter((t) => t.buy).reduce((a, t) => a + t.amountIn, 0n));
  return move(`trades ${spend} ${when}`, `Would trade ${spend}`);
}

const RULES: Record<Agent, (i: NextInput) => Next> = {
  protect: protectNext,
  rebalance: rebalanceNext,
};

/** Every agent's next line: the executor's plan for the agent it names, each agent's own rule for the rest. */
export function agentNexts(i: NextInput): Record<Agent, Next> {
  const planned = i.plan && planNext(i.plan);
  return Object.fromEntries(AGENTS.map((a) => [a, planned?.agent === a ? planned.next : RULES[a](i)])) as Record<
    Agent,
    Next
  >;
}

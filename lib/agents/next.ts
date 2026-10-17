import { CASH_AGENT } from "@/config/risk";
import { OFF_REASONS } from "@/lib/agents/events";
import { OFF_WHY } from "@/lib/agents/feed";
import { agentOf, AGENTS, timeText, type Agent, type Next, type WeekendCard } from "@/lib/agents/list";
import { isMix, previewTrades, type MixHolding } from "@/lib/agents/mix";
import { JOBS, readStockLimits, type AgentJob } from "@/lib/agents/permissions";
import { planProtect, weekendHeadsUp } from "@/lib/agents/rules/protect";
import type { RebalanceOptions } from "@/lib/agents/rules/rebalance";
import { formatUsdTrim } from "@/lib/formatting";
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
  /** How long before a price freeze the weekend heads-up card shows, in seconds (the executor's `amounts`). */
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
const ACTIONS = [
  "none",
  "prune",
  "repay",
  "save",
  "sell",
  "heads-up",
  "clear-heads-up",
  "defer",
  "rebalance",
  "convert",
] as const;

/**
 * The plan's move in words, and the agent it's for; null when a run would do nothing, or when it's a job with no agent
 * on screen (Save's and Entry's moves, D20).
 */
export function planNext(p: Plan): { agent: Agent; next: Next } | null {
  const job: AgentJob | undefined = JOBS[p.job];
  const agent = job ? agentOf(job) : null;
  const action = ACTIONS[p.action];
  if (!agent || !action || action === "none" || action === "save" || action === "convert") return null;
  const a = usd(p.amount);
  const next: Next =
    action === "prune"
      ? { idle: `Stopping${OFF_WHY[OFF_REASONS[p.off] ?? "revoked"]}` }
      : action === "repay"
        ? move(`repays ${a} from your cash`, `Would repay ${a} from your cash`)
        : action === "sell"
          ? move(`sells backing stock to repay ${a}`, `Would sell backing stock to repay ${a}`)
          : action === "heads-up"
            ? move("sends you a heads-up before selling", "Would send you a heads-up before selling")
            : action === "clear-heads-up"
              ? move("clears the heads-up", "Would clear the heads-up")
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
 * which it hasn't traded yet (`ranDay`, the registry's rebalanceDay). Holidays are the executor's own calendar.
 */
export function rebalanceCheckAt(nowSec: number, ranDay: number): number {
  for (let d = nyDay(nowSec); ; d++) {
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
  plan: Plan | null;
};

const smaller = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Protect: repays from savings only in Act, back to its target in Watch (planProtect; Act is the line, 2026-10-15).
 * In Safe or Watch it says it waits for Act.
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
    minRepayUsd: Number(i.numbers.minRepayRaw) / 10 ** USDC.decimals,
  });
  if (d.action === "repay") {
    const a = formatUsdTrim(Math.ceil(d.amountUsd * 100) / 100);
    return move(`repays ${a} from your cash`, `Would repay ${a} from your cash`);
  }
  if (d.reason === "no-debt") return { idle: "Nothing owed. Nothing to do." };
  const status = statusFor(d.hf);
  // Act is never healthy for the rule: the executor pins its trigger to the Act line (D13's was higher). A fallback line.
  if (d.reason === "healthy") {
    return {
      idle:
        status === "safe"
          ? "Safe. Nothing to do."
          : status === "watch"
            ? "Watch. Steps in only at Act"
            : "Act. Nothing to repay yet",
    };
  }
  const label = STATUS_LABEL[status];
  if (d.reason === "too-small") return { idle: `${label}. Nothing worth repaying yet` };
  return { idle: d.reason === "no-savings" ? `${label}. No cash to repay with` : `${label}. Today’s limit is used` };
}

/**
 * The weekend heads-up card (lib/agents/rules/protect.ts `weekendHeadsUp`, on the executor's live numbers): in the window
 * before the next price freeze, credit outside Act that the stress drop would take into it. No move: a card only.
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

/** Rebalance: the trades its rule finds for the saved mix on today's free shares, at the next window. */
function rebalanceNext(i: NextInput): Next {
  if (!i.mixBps || !isMix(i.mixBps) || i.mixBps.every((w) => w === 0)) return { idle: "No mix yet" };
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
  const when = whenText(rebalanceCheckAt(i.nowSec, i.rebalanceDay), i.nowSec);
  if (trades.length === 0) return { idle: `On target. Checks ${when}` };
  // GooseExecutor's RebalanceJob waits while Protect may act: below Protect's trigger, the Act line.
  const hf = i.debtUsd > 0 ? (i.totalBackingUsd * i.avgCf) / i.debtUsd : Infinity;
  if (hf < i.numbers.triggerHf) return { idle: "Waits until your credit is out of Act" };
  const spend = usd(trades.filter((t) => t.buy).reduce((a, t) => a + t.amountIn, 0n));
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

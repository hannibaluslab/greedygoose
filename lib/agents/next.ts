import { CASH, CASH_AGENT, ENTRY } from "@/config/risk";
import { OFF_REASONS } from "@/lib/agents/events";
import { OFF_WHY } from "@/lib/agents/feed";
import { agentOf, AGENTS, type Agent, type Next } from "@/lib/agents/list";
import { isMix, previewTrades, type MixHolding } from "@/lib/agents/mix";
import { JOBS, readStockLimits, type AgentJob } from "@/lib/agents/permissions";
import { planEntry, type EntryOptions } from "@/lib/guardian/entry";
import { inWeekendWindow, planGuardian, planSave } from "@/lib/guardian/plan";
import type { RebalanceOptions } from "@/lib/guardian/rebalance";
import { formatUsdTrim } from "@/lib/formatting";
import { STATUS_LABEL, statusFor, type Status } from "@/lib/risk/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/*
 * What each agent does next. With an executor configured, its `planOf(account)` names the first job, in its order,
 * with a move; every other agent reads its TypeScript rule (lib/guardian/*.ts, which the contract matches through the
 * differential tests) on live data. With none configured, every agent reads its rule.
 */

const usd = (raw: bigint) => formatUsdTrim(Number(raw) / 10 ** USDC.decimals);
const move = (will: string, would: string): Next => ({ will, would });
const coinAmount = (raw: bigint, decimals: number) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The executor's numbers the rules take (its registry, D18); config/risk.ts mirrors its deploy defaults. */
export type RuleNumbers = {
  keepBackRaw: bigint;
  minSaveRaw: bigint;
  maxSavesPerDay: number;
  minRepayRaw: bigint;
  triggerHf: number;
  targetHf: number;
  stressDrop: number;
  stressFloorHf: number;
  rebalance: RebalanceOptions;
  entry: EntryOptions;
};

const raw = (usdAmount: number) => BigInt(Math.round(usdAmount * 10 ** USDC.decimals));

/** The deploy defaults, for when no executor is configured. */
export function defaultNumbers(rebalance: RebalanceOptions): RuleNumbers {
  return {
    keepBackRaw: raw(CASH.keepBackUsd),
    minSaveRaw: raw(CASH_AGENT.minSaveUsd),
    maxSavesPerDay: CASH_AGENT.maxSavesPerDay,
    minRepayRaw: raw(CASH_AGENT.minRepayUsd),
    triggerHf: CASH_AGENT.triggerHf,
    targetHf: CASH_AGENT.targetHf,
    stressDrop: CASH_AGENT.stressDrop,
    stressFloorHf: CASH_AGENT.stressFloorHf,
    rebalance,
    entry: { floorBps: BigInt(ENTRY.floorBps), minEntryRaw: raw(ENTRY.minEntryUsd), maxSwapRaw: raw(ENTRY.maxSwapUsd) },
  };
}

/** GooseExecutor's `planOf(account)`: what a run would do for the account now. */
export type Plan = { action: number; job: number; amount: bigint; reason: number; off: number };

/** GooseExecutor's Action, in order. */
const ACTIONS = ["none", "prune", "repay", "save", "sell", "heads-up", "clear-heads-up", "defer", "rebalance", "convert"] as const;

/** The plan's move in words, and the job it's for; null when a run would do nothing. */
export function planNext(p: Plan): { job: AgentJob; next: Next } | null {
  const job = JOBS[p.job];
  const action = ACTIONS[p.action];
  if (!job || !action || action === "none") return null;
  const a = usd(p.amount);
  const next: Next =
    action === "prune"
      ? { idle: `Stopping${OFF_WHY[OFF_REASONS[p.off] ?? "revoked"]}` }
      : action === "repay"
        ? move(`repays ${a} from your cash`, `Would repay ${a} from your cash`)
        : action === "save"
          ? move(`saves ${a}`, `Would save ${a}`)
          : action === "sell"
            ? move(`sells backing stock to repay ${a}`, `Would sell backing stock to repay ${a}`)
            : action === "heads-up"
              ? move("sends you a heads-up before selling", "Would send you a heads-up before selling")
              : action === "clear-heads-up"
                ? move("clears the heads-up", "Would clear the heads-up")
                : action === "defer"
                  ? move("finishes its last move", "Would finish its last move")
                  : action === "rebalance"
                    ? move(`trades ${a}`, `Would trade ${a}`)
                    : move(`turns ${ENTRY_COINS[p.reason]?.symbol ?? "a coin"} into cash`, `Would turn ${ENTRY_COINS[p.reason]?.symbol ?? "a coin"} into cash`);
  return { job, next };
}

/** New York's calendar day of `sec`, counted from 1970-01-01, as GooseExecutor's NyCalendar.day counts it. */
export function nyDay(sec: number): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" });
  const p = Object.fromEntries(f.formatToParts(sec * 1000).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000;
}

/** The second `hour`:00 New York time falls on, on New York day `day`. */
function nyHour(day: number, hour: number): number {
  const est = day * 86_400 + (hour + 5) * 3_600;
  const shown = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(est * 1000));
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
  /** Wallet USDC, and savings (Aave V3), USDC units. */
  walletRaw: bigint;
  savingsRaw: bigint;
  collateralUsd: number;
  avgCf: number;
  debtUsd: number;
  credit: Status;
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
  /** Saves made today and the New York day the Rebalancer last traded (the registry's `accounts`). */
  savesToday: number;
  rebalanceDay: number;
  /** Each Entry coin in the wallet (raw units) and when it may be tried again (seconds; 0 = not waiting). */
  entryRaw: readonly bigint[];
  entryRetryAt: readonly number[];
  plan: Plan | null;
};

const smaller = (a: bigint, b: bigint) => (a < b ? a : b);

/** Save: wallet USDC above the keep-back goes into savings, within today's limit (planSave). */
function saveNext(i: NextInput): Next {
  const d = planSave({
    walletRaw: i.walletRaw,
    capLeftRaw: i.left.save?.[0]?.leftRaw ?? i.capRaw.save,
    savesToday: i.savesToday,
    keepBackRaw: i.numbers.keepBackRaw,
    minSaveRaw: i.numbers.minSaveRaw,
    maxSavesPerDay: i.numbers.maxSavesPerDay,
  });
  if (d.action === "save") return move(`saves ${usd(d.amountRaw)}`, `Would save ${usd(d.amountRaw)}`);
  return { idle: d.reason === "too-small" ? "Nothing to save" : d.reason === "no-cap" ? "Today’s limit is used" : "Done for today" };
}

/** Protect: repays from savings below Safe, back up to its target; Weekend Shield before a freeze (planGuardian). */
function protectNext(i: NextInput): Next {
  const left = i.left.protect;
  const d = planGuardian({
    collateralUsd: i.collateralUsd,
    avgCf: i.avgCf,
    debtUsd: i.debtUsd,
    savingsUsd: Number(i.savingsRaw) / 10 ** USDC.decimals,
    capLeftUsd: Number(left ? left.map((s) => s.leftRaw).reduce(smaller) : i.capRaw.protect) / 10 ** USDC.decimals,
    weekendWindow: inWeekendWindow(new Date(i.nowSec * 1000)),
    triggerHf: i.numbers.triggerHf,
    targetHf: i.numbers.targetHf,
    stressDrop: i.numbers.stressDrop,
    stressFloorHf: i.numbers.stressFloorHf,
    minRepayUsd: Number(i.numbers.minRepayRaw) / 10 ** USDC.decimals,
  });
  if (d.action === "repay") {
    const a = formatUsdTrim(Math.ceil(d.amountUsd * 100) / 100);
    return move(`repays ${a} from your cash`, `Would repay ${a} from your cash`);
  }
  if (d.reason === "no-debt") return { idle: "Nothing owed. Nothing to do." };
  if (d.reason === "healthy" || d.reason === "too-small") return { idle: "Safe. Nothing to do." };
  const status = STATUS_LABEL[statusFor(d.hf)];
  return { idle: d.reason === "no-savings" ? `${status}. No cash to repay with` : `${status}. Today’s limit is used` };
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
    left: left ? {
      usdcRaw: left[0].leftRaw,
      stocksRaw: readStockLimits("rebalance", left.map((s) => ({ token: s.token, allowance: s.leftRaw }))) ?? EQUITIES.map(() => 0n),
    } : undefined,
  });
  const when = whenText(rebalanceCheckAt(i.nowSec, i.rebalanceDay), i.nowSec);
  if (trades.length === 0) return { idle: `On target. Checks ${when}` };
  if (i.credit === "watch" || i.credit === "act") return { idle: "Waits until your credit is Safe" };
  const spend = usd(trades.filter((t) => t.buy).reduce((a, t) => a + t.amountIn, 0n));
  return move(`trades ${spend} ${when}`, `Would trade ${spend}`);
}

/** Receive: the first coin worth converting, all of it up to a run's most, at 99.5% or better (planEntry). */
function receiveNext(i: NextInput): Next {
  const scale = (k: number) => 10n ** BigInt(ENTRY_COINS[k].decimals - USDC.decimals);
  const coins = ENTRY_COINS.map((c, k) => ({
    balanceRaw: i.entryRaw[k] ?? 0n,
    decimals: c.decimals,
    limitLeftRaw: i.left.entry?.[k]?.leftRaw ?? i.capRaw.entry * scale(k),
    waiting: (i.entryRetryAt[k] ?? 0) > i.nowSec,
  }));
  const m = planEntry(coins, i.numbers.entry);
  if (m) {
    const c = ENTRY_COINS[m.index];
    const amount = `${coinAmount(m.amountIn, c.decimals)} ${c.symbol}`;
    return move(`turns ${amount} into cash`, `Would turn ${amount} into cash`);
  }
  const w = coins.findIndex((c) => c.waiting && c.balanceRaw > 0n);
  if (w >= 0) return { idle: `${ENTRY_COINS[w].symbol} waits until ${TIME.format(i.entryRetryAt[w] * 1000)}` };
  return { idle: "Nothing waiting" };
}

const RULES: Record<Agent, (i: NextInput) => Next> = {
  save: saveNext,
  protect: protectNext,
  rebalance: rebalanceNext,
  receive: receiveNext,
};

/** Every agent's next line: the executor's plan for the job it names, each agent's own rule for the rest. */
export function agentNexts(i: NextInput): Record<Agent, Next> {
  const planned = i.plan && planNext(i.plan);
  return Object.fromEntries(
    AGENTS.map((a) => [a, planned && agentOf(planned.job) === a ? planned.next : RULES[a](i)]),
  ) as Record<Agent, Next>;
}

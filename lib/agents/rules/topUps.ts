/**
 * Top-ups go into my mix (docs/SPEC.md, Agents): money that comes in from outside fills Keep $X as cash first, and the
 * part above goes into the mix at the next market morning's check, never the day it arrived. Only Save counts top-ups,
 * leaving out the agents' own change; Rebalance puts in what was counted on an earlier day, buying the stocks furthest
 * below their target first. A fall in savings after a count comes out of what's waiting first, and rises never add to
 * it.
 *
 * Integer on-chain units only, so GooseExecutor's ports must agree exactly: the counts in contracts/src/CashRules.sol
 * and the buys in RebalanceRules.invest. test/CashRules.t.sol and test/RebalanceRules.t.sol run both on the vectors from
 * scripts/agent-vectors.ts. Units: USDC units with 6 decimals, New York days counted from 1970-01-01.
 */
import type { RebalanceBook, RebalanceOptions, RebalanceTrade } from "@/lib/agents/rules/rebalance";

/** What GooseExecutor keeps for one account (`topUps(account)`), less the switch: the counts and Keep. */
export type TopUpsState = {
  /** The New York day `todayRaw` was counted on. */
  day: number;
  /** Keep $X as cash: savings up to it never go into the mix. */
  keepRaw: bigint;
  /** Counted on an earlier day: goes in at the next market morning's check. */
  readyRaw: bigint;
  /** Counted on `day`: never goes in the day it arrived. */
  todayRaw: bigint;
  /** Savings when the executor last looked: a fall under it comes out of what's waiting. */
  markRaw: bigint;
  /** The agents' own change in the wallet, which Save puts away without counting it. */
  ownRaw: bigint;
};

const BPS = 10_000n;
const min = (...v: bigint[]) => v.reduce((a, b) => (b < a ? b : a));
const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** Today's count joins what's ready once its New York day is over. */
function roll(t: TopUpsState, day: number): TopUpsState {
  return t.day === day ? t : { ...t, readyRaw: t.readyRaw + t.todayRaw, todayRaw: 0n, day };
}

/** A fall in savings since the executor last looked comes out of what's waiting, what's ready first. The mark moves. */
function fall(t: TopUpsState, savingsRaw: bigint): TopUpsState {
  const f = sub(t.markRaw, savingsRaw);
  const r = min(f, t.readyRaw);
  return { ...t, readyRaw: t.readyRaw - r, todayRaw: t.todayRaw - min(f - r, t.todayRaw), markRaw: savingsRaw };
}

/** What's waiting is never more than savings above Keep; today's count is trimmed first. */
function clamp(t: TopUpsState, savingsRaw: bigint): TopUpsState {
  const room = sub(savingsRaw, t.keepRaw);
  const readyRaw = min(t.readyRaw, room);
  return { ...t, readyRaw, todayRaw: min(t.todayRaw, room - readyRaw) };
}

/**
 * Save's count: `savedRaw` went from the wallet into savings, which held `beforeRaw` and now hold `savingsRaw`. The
 * agents' own change in it is left out; the rest is a top-up counted today, after any fall and within savings above
 * Keep, so it fills Keep first.
 */
export function topUpCounted(
  t: TopUpsState,
  day: number,
  beforeRaw: bigint,
  savedRaw: bigint,
  savingsRaw: bigint,
): { state: TopUpsState; countedRaw: bigint } {
  const s = fall(roll(t, day), beforeRaw);
  const mine = min(savedRaw, s.ownRaw);
  const waiting = s.readyRaw + s.todayRaw;
  const c = clamp({ ...s, ownRaw: s.ownRaw - mine, todayRaw: s.todayRaw + savedRaw - mine }, savingsRaw);
  const state = { ...c, markRaw: savingsRaw };
  return { state, countedRaw: sub(state.readyRaw + state.todayRaw, waiting) };
}

/**
 * What Rebalance may put into the mix at the check on `day`, with `savingsRaw` now: what was counted on an earlier day,
 * less any fall since, within savings above Keep. `state` is what the executor keeps if that check trades.
 */
export function topUpsReady(t: TopUpsState, day: number, savingsRaw: bigint): { state: TopUpsState; readyRaw: bigint } {
  const state = clamp(fall(roll(t, day), savingsRaw), savingsRaw);
  return { state, readyRaw: state.readyRaw };
}

/** After `investRaw` went from savings into the mix, savings hold `savingsRaw`: it comes out of what's ready. */
export function topUpInvested(t: TopUpsState, investRaw: bigint, savingsRaw: bigint): TopUpsState {
  return { ...clamp({ ...t, readyRaw: t.readyRaw - investRaw }, savingsRaw), markRaw: savingsRaw };
}

/**
 * What waits to go into the mix on `day`, with `savingsRaw` now: `readyRaw` goes in at that day's check, `todayRaw` at
 * the next market day's. What the sheet shows as waiting is the two together.
 */
export function waitingRaw(t: TopUpsState, day: number, savingsRaw: bigint): { readyRaw: bigint; todayRaw: bigint } {
  const s = clamp(fall(roll(t, day), savingsRaw), savingsRaw);
  return { readyRaw: s.readyRaw, todayRaw: s.todayRaw };
}

/**
 * The buys that put `amountRaw` of top-ups into the mix: the stock furthest below its target first, each target taken
 * against the mix with the top-up in (total + amount), ties to the lower reserve id. Each buy is at least `minTradeRaw`,
 * at most `maxSliceRaw` and never past its target, so a mix on target buys pro rata. It never sells. The buys spend
 * exactly their `amountIn`; what they leave of the amount waits for the next check. In reserve order.
 */
export function investTrades(
  book: Pick<RebalanceBook, "stocks">,
  amountRaw: bigint,
  o: Pick<RebalanceOptions, "floorBps" | "minTradeRaw" | "maxSliceRaw">,
): RebalanceTrade[] {
  const s = book.stocks;
  const values = s.map((h) => (h.weightBps > 0n ? (h.sharesRaw * h.price) / 10n ** 10n : 0n));
  const total = values.reduce((a, b) => a + b, amountRaw);
  const gap = s.map((h, i) => (h.weightBps > 0n ? sub((total * h.weightBps) / BPS, values[i]) : 0n));
  const order = s
    .map((_, i) => i)
    .filter((i) => s[i].weightBps > 0n && gap[i] > 0n)
    .sort((a, b) => (gap[a] === gap[b] ? a - b : gap[a] > gap[b] ? -1 : 1));
  const buy = s.map(() => 0n);
  let left = amountRaw;
  for (const i of order) {
    if (left === 0n) break;
    const leg = min(left, gap[i], o.maxSliceRaw);
    if (leg < o.minTradeRaw) continue;
    buy[i] = leg;
    left -= leg;
  }
  return buy.flatMap((usdcIn, i) =>
    usdcIn > 0n
      ? [
          {
            reserveId: i,
            buy: true,
            amountIn: usdcIn,
            minOut: (usdcIn * 10n ** 10n * (BPS - o.floorBps)) / (s[i].price * BPS),
          },
        ]
      : [],
  );
}

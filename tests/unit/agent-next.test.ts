import { describe, expect, it } from "vitest";
import {
  actWarning,
  agentNexts,
  atText,
  beforeFreeze,
  defaultNumbers,
  nextRound,
  planNext,
  REBALANCE_GAP_SEC,
  REBALANCE_SESSION_SEC,
  rebalanceCheckAt,
  weekendCard,
  whenText,
  type NextInput,
} from "@/lib/agents/next";
import { rebalanceOptions } from "@/lib/agents/mix";

const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const price = (usd: number) => BigInt(Math.round(usd * 1e8));
const free = (reserveId: number, usd: number, p: number) => ({
  reserveId,
  priceRaw: price(p),
  freeRaw: BigInt(Math.round((usd / p) * 1e8)),
});
/** Wednesday 2025-10-15 12:00 New York (16:00 UTC, daylight time). */
const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;

/** $400 of cash earning, $600 owed against $2,000 at a 70% factor (Safe), 50/50 Apple and NVIDIA on target. */
function input(over: Partial<NextInput> = {}): NextInput {
  return {
    nowSec: WED_NOON,
    savingsRaw: usdc(400),
    totalBackingUsd: 2_000,
    avgCf: 0.7,
    debtUsd: 600,
    holdings: [free(0, 5_000, 250), free(5, 5_000, 180)],
    mixBps: [5_000, 0, 0, 0, 0, 5_000, 0],
    numbers: defaultNumbers(rebalanceOptions()),
    pacing: { sessionAt: 0, mixSetAt: 0 },
    rescuing: false,
    sellOn: false,
    plan: null,
    ...over,
  };
}

describe("agentNexts: each agent's rule on live data", () => {
  it("is Protector's and Rebalancer's only: earning and converting other dollars have no line (D20)", () => {
    expect(Object.keys(agentNexts(input()))).toEqual(["protect", "rebalance"]);
  });

  it("Protector repays from savings only under 1.03, back to 1.12, and says why it doesn't otherwise", () => {
    expect(agentNexts(input()).protect).toEqual({ idle: "Safe. Nothing to do." });
    expect(agentNexts(input({ debtUsd: 0 })).protect).toEqual({ idle: "Nothing owed, nothing to do." });
    // $1,400 of power against $1,000 owed is 1.4: Watch is fine.
    expect(agentNexts(input({ debtUsd: 1_000 })).protect).toEqual({ idle: "Watch. Protector steps in at 1.03" });
    // Against $1,300 it's 1.077: Act is a warning only (Adrian, 2026-10-19), Protect waits for its line.
    expect(agentNexts(input({ debtUsd: 1_300 })).protect).toEqual({ idle: "Act. Protector steps in at 1.03" });
    // Against $1,380 it's 1.014, under the line: back to 1.12 needs $130, rounded up to the cent.
    const under = input({ debtUsd: 1_380 });
    expect(agentNexts(under).protect).toEqual({
      will: "repays $130.01 from your cash",
      would: "Would repay $130.01 from your cash",
    });
    // A rescue it started goes on above the line, until 1.12: from 1.077 that's $50.
    expect(agentNexts(input({ debtUsd: 1_300, rescuing: true })).protect).toEqual({
      will: "repays $50.01 from your cash",
      would: "Would repay $50.01 from your cash",
    });
    expect(agentNexts(input({ debtUsd: 1_250, rescuing: true })).protect).toEqual({
      idle: "Watch. Protector steps in at 1.03",
    });
    // No cash: a sale follows when selling is on, weekends too (decision 7: no line says it waits for prices to reopen).
    expect(agentNexts({ ...under, savingsRaw: 0n }).protect).toEqual({ idle: "Act. No cash to repay with" });
    expect(agentNexts({ ...under, savingsRaw: 0n, sellOn: true }).protect).toEqual({
      will: "sells backing stock to repay",
      would: "Would sell backing stock to repay",
    });
    // No amount limit and no smallest repay (decision 9): a cent under the line is repaid too.
    expect(agentNexts(input({ debtUsd: 1_400 / 1.0299 })).protect).toMatchObject({
      will: expect.stringMatching(/^repays/),
    });
    for (const n of [agentNexts(under), agentNexts({ ...under, savingsRaw: 0n, sellOn: true })])
      expect(JSON.stringify(n.protect)).not.toMatch(/limit|next run|reopen|weekend/i);
  });

  it("warns in Act from a plain health check: down to Protector's line while it's on, all the way while it's off", () => {
    const numbers = defaultNumbers(rebalanceOptions());
    const at = (healthFactor: number | null, debtUsd: number, protectOn = true) =>
      actWarning({ healthFactor, totalBackingUsd: 2_000, avgCf: 0.7, debtUsd, numbers, protectOn });
    // 1.077: in Act, above 1.03. Back to 1.12 takes $50.
    expect(at(1_400 / 1_300, 1_300)).toEqual({ addUsd: 50, protectOn: true });
    expect(at(1_400 / 1_300, 1_300, false)).toEqual({ addUsd: 50, protectOn: false });
    expect(at(1.03, 1_400 / 1.03)).toMatchObject({ protectOn: true });
    // Watch, under Protect's line with Protect on (it acts itself), or nothing owed: no card.
    expect(at(1.1, 1_400 / 1.1)).toBeNull();
    expect(at(1_400 / 1_380, 1_380)).toBeNull();
    expect(at(null, 0)).toBeNull();
    // Protect off: nothing acts under its line, so the warning stays. Back to 1.12 from $1,380 owed takes $130.
    expect(at(1_400 / 1_380, 1_380, false)).toEqual({ addUsd: 130, protectOn: false });
  });

  it("shows the weekend card only: before the Friday freeze, when a 15% drop would take the credit under Aave's line", () => {
    // Friday 2025-10-17 14:30 New York (18:30 UTC); $1,400 of power against $1,250 owed is 1.12 (Watch), 0.952 after −15%.
    // The executor's nextFreeze: 20:00 New York, 00:00 UTC on Saturday.
    const fri = Date.UTC(2025, 9, 17, 18, 30) / 1000;
    const freezeAt = Date.UTC(2025, 9, 18, 0) / 1000;
    const at = (nowSec: number, debtUsd: number, over: Partial<NextInput> = {}) => ({
      ...input({ nowSec, debtUsd, ...over }),
      freezeAt,
    });
    const card = weekendCard(at(fri, 1_250));
    expect(card).toEqual({
      addUsd: 159,
      dropPct: 15,
      when: atText(freezeAt, fri), // the viewer's day and clock, with its GMT offset
    });
    // No move with it: Protect waits for its line.
    expect(agentNexts(input({ nowSec: fri, debtUsd: 1_250 })).protect).toEqual({
      idle: "Watch. Protector steps in at 1.03",
    });
    expect(weekendCard(at(fri - 3 * 3600, 1_250))).toBeNull(); // 11:30: not yet
    expect(weekendCard(at(WED_NOON, 1_250))).toBeNull(); // a Wednesday
    expect(weekendCard(at(fri, 1_120))).toBeNull(); // 1.25: −15% leaves 1.0625, over Aave's line
    expect(weekendCard(at(fri, 1_300))).toMatchObject({ addUsd: 209 }); // 1.077, in Act: the card still shows
    expect(weekendCard(at(fri, 1_380))).toBeNull(); // under Protector's line, Protector acts itself
    expect(weekendCard({ ...at(fri, 1_250), freezeAt: null })).toBeNull(); // the executor's calendar not read yet
  });

  it("follows the executor's calendar and window, not a fixed Friday: holidays, a freeze already on, a shorter window", () => {
    const wedFreeze = Date.UTC(2025, 9, 16, 0) / 1000; // Wednesday 20:00 New York, before a Thursday the executor holds
    expect(
      weekendCard({ ...input({ debtUsd: 1_250 }), nowSec: wedFreeze - 2 * 3600, freezeAt: wedFreeze }),
    ).toMatchObject({ addUsd: 159 });
    // Good Friday: prices are already held, so nextFreeze gives back the hour asked (not after now): no card.
    const goodFriday = Date.UTC(2026, 3, 3, 18, 30) / 1000;
    expect(weekendCard({ ...input({ nowSec: goodFriday, debtUsd: 1_250 }), freezeAt: goodFriday - 1_800 })).toBeNull();
    // The window is the executor's: with 3 hours, 14:30 is too early for a 20:00 freeze.
    const fri = Date.UTC(2025, 9, 17, 18, 30) / 1000;
    const short = { ...defaultNumbers(rebalanceOptions()), weekendWindowSec: 3 * 3600 };
    expect(
      weekendCard({
        ...input({ nowSec: fri, debtUsd: 1_250, numbers: short }),
        freezeAt: Date.UTC(2025, 9, 18, 0) / 1000,
      }),
    ).toBeNull();
    expect(beforeFreeze(100, 100, 3600)).toBe(false); // the freeze itself is not before it
    expect(beforeFreeze(99, 100, 3600)).toBe(true);
    expect(beforeFreeze(100 - 3601, 100, 3600)).toBe(false);
  });

  it("Rebalancer checks its mix at the next round, trades when a stock breaks its band, and waits while the credit is in Act", () => {
    // The next round, 10 minutes on the clock's tens, in the viewer's own words.
    expect(agentNexts(input()).rebalance).toEqual({
      idle: `On target. Checks ${whenText(nextRound(WED_NOON), WED_NOON)}`,
    });
    expect(agentNexts(input({ mixBps: null })).rebalance).toEqual({ idle: "No mix yet" });
    // 60/40 against a 50/50 mix: Apple broke out by 10 points.
    const drifted = input({ holdings: [free(0, 6_000, 250), free(5, 4_000, 180)] });
    const n = agentNexts(drifted).rebalance;
    expect(n).toMatchObject({ would: expect.stringMatching(/^Would trade \$\d+(\.\d\d)?$/) });
    expect("will" in n && n.will).toMatch(/^trades \$\d+(\.\d\d)? today /);
    // Paced: a session that closed an hour ago waits for its 20 hours, unless the user set a new mix since.
    const paced = { ...drifted, pacing: { sessionAt: WED_NOON - 2 * 3_600, mixSetAt: 0 } };
    expect("will" in agentNexts(paced).rebalance && agentNexts(paced).rebalance).toMatchObject({
      will: expect.stringMatching(/^trades \$\d+(\.\d\d)? tomorrow /),
    });
    const fresh = { ...paced, pacing: { ...paced.pacing, mixSetAt: WED_NOON - 60 } };
    expect(agentNexts(fresh).rebalance).toEqual(agentNexts(drifted).rebalance);
    // Watch is fine for the Rebalancer too: it waits only in Act (1.10, GooseGuard's invest health), not down to
    // Protect's line (1.03): at 1.077 it waits.
    expect(agentNexts({ ...drifted, debtUsd: 1_000 }).rebalance).toMatchObject({
      would: expect.stringMatching(/^Would trade/),
    });
    expect(agentNexts({ ...drifted, debtUsd: 1_300 }).rebalance).toEqual({
      idle: "Waits until your credit is out of Act",
    });
  });

  it("takes the executor's plan for the job it names, and the rules for the rest", () => {
    // Action 2 (Repay) for job 1 (Protect): $120.
    const n = agentNexts(input({ plan: { action: 2, job: 1, amount: usdc(120), reason: 5, off: 0 } }));
    expect(n.protect).toEqual({ will: "repays $120 from your cash", would: "Would repay $120 from your cash" });
    expect(n.rebalance).toEqual(agentNexts(input()).rebalance);
    // A Save (action 3, job 0) or a conversion (action 8, job 4) is under the hood: every agent reads its rule.
    expect(agentNexts(input({ plan: { action: 3, job: 0, amount: usdc(40), reason: 0, off: 0 } }))).toEqual(
      agentNexts(input()),
    );
    expect(agentNexts(input({ plan: { action: 8, job: 4, amount: usdc(119), reason: 0, off: 0 } }))).toEqual(
      agentNexts(input()),
    );
    // Ending a rescue (action 5) moves no money: Protect's own rule says where the credit stands.
    expect(agentNexts(input({ plan: { action: 5, job: 1, amount: 0n, reason: 0, off: 0 } }))).toEqual(
      agentNexts(input()),
    );
    // A sale is Protect's too; a plan with nothing to do changes nothing.
    expect(
      agentNexts(input({ plan: { action: 4, job: 2, amount: usdc(90), reason: 1, off: 0 } })).protect,
    ).toMatchObject({
      will: "sells backing stock to repay $90",
    });
    expect(agentNexts(input({ plan: { action: 0, job: 0, amount: 0n, reason: 0, off: 0 } }))).toEqual(
      agentNexts(input()),
    );
  });

  it("names every move the executor can plan for an agent, and none of Save's or Entry's", () => {
    // [action, job]: Prune Protect, Repay, Sell, Defer, Rebalance.
    const planned = (
      [
        [1, 1],
        [2, 1],
        [4, 2],
        [6, 2],
        [7, 3],
      ] as const
    ).map(([action, job]) => planNext({ action, job, amount: usdc(10), reason: 0, off: 1 })!);
    expect(planned.map((p) => p.agent)).toEqual(["protect", "protect", "protect", "protect", "rebalance"]);
    const words = planned.map((p) => p.next);
    expect(words[0]).toEqual({ idle: "Stopping: a year has passed since you switched it on." });
    expect(words.slice(1).map((w) => ("will" in w ? w.will : w.idle))).toEqual([
      "repays $10 from your cash",
      "sells backing stock to repay $10",
      "finishes its last move",
      "trades $10",
    ]);
    // Ending a rescue (EndRescue, for either of Protect's jobs) has nothing to say.
    expect(planNext({ action: 5, job: 1, amount: 0n, reason: 0, off: 0 })).toBeNull();
    expect(planNext({ action: 5, job: 2, amount: 0n, reason: 0, off: 0 })).toBeNull();
    for (const w of words)
      expect(JSON.stringify(w)).not.toMatch(/borrow|lock|permission|executor|upkeep|registry|spender|saving/i);
    // Save (job 0) and Entry (job 4), even a prune: nothing to say on the Agents tab.
    for (const [action, job] of [
      [3, 0],
      [1, 0],
      [8, 4],
      [1, 4],
    ] as const) {
      expect(planNext({ action, job, amount: usdc(10), reason: 0, off: 1 })).toBeNull();
    }
  });
});

describe("the Rebalancer's pacing (GooseGuard, decision 4): at most once a day, unless the user sets a new mix", () => {
  it("rounds are 10 minutes apart, on the clock's tens", () => {
    expect(nextRound(WED_NOON)).toBe(WED_NOON + 600);
    expect(nextRound(WED_NOON + 1)).toBe(WED_NOON + 600);
    expect(nextRound(WED_NOON + 599)).toBe(WED_NOON + 600);
  });

  it("trades at the next round with no session yet, inside its hour, or after 20 hours; else when the 20 hours end", () => {
    const at = (sessionAt: number, mixSetAt = 0) => rebalanceCheckAt(WED_NOON, { sessionAt, mixSetAt });
    expect(at(0)).toBe(nextRound(WED_NOON));
    // The session opened 20 minutes ago: the next round is still in its hour.
    expect(at(WED_NOON - 1_200)).toBe(nextRound(WED_NOON));
    // Opened 55 minutes ago: the next round falls past its hour, so it waits for the 20 hours.
    expect(at(WED_NOON - 3_300)).toBe(nextRound(WED_NOON - 3_300 + REBALANCE_GAP_SEC - 1));
    expect(at(WED_NOON - 3_300) - (WED_NOON - 3_300 + REBALANCE_GAP_SEC)).toBe(300); // the first round after
    // Opened 5 hours ago: the first round from 20 hours after it opened.
    expect(at(WED_NOON - 5 * 3_600)).toBe(WED_NOON - 5 * 3_600 + REBALANCE_GAP_SEC);
    // 20 hours on: a new session at the next round.
    expect(at(WED_NOON - REBALANCE_GAP_SEC)).toBe(nextRound(WED_NOON));
    // A new mix since the session opened: the next round, whatever the wait.
    expect(at(WED_NOON - 5 * 3_600, WED_NOON - 60)).toBe(nextRound(WED_NOON));
    expect(REBALANCE_SESSION_SEC).toBe(3_600);
  });

  it("has no calendar: a Saturday is like any day (decision 7)", () => {
    const sat = Date.UTC(2025, 9, 18, 16) / 1000;
    expect(rebalanceCheckAt(sat, { sessionAt: 0, mixSetAt: 0 })).toBe(nextRound(sat));
  });

  it("says when in the viewer's own day", () => {
    expect(whenText(WED_NOON + 3600, WED_NOON)).toMatch(/^today /);
    expect(whenText(WED_NOON + 86_400, WED_NOON)).toMatch(/^tomorrow /);
    expect(whenText(WED_NOON + 5 * 86_400, WED_NOON)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
  });
});

import { describe, expect, it } from "vitest";
import {
  agentNexts,
  beforeFreeze,
  defaultNumbers,
  nyDay,
  planNext,
  rebalanceCheckAt,
  weekendCard,
  whenText,
  type NextInput,
} from "@/lib/agents/next";
import { rebalanceOptions } from "@/lib/agents/mix";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";
import { USDC } from "@/lib/tokens/registry";

const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const byJob = <T>(f: (job: AgentJob) => T) =>
  Object.fromEntries(JOBS.map((job) => [job, f(job)])) as Record<AgentJob, T>;
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
    left: byJob(() => null),
    capRaw: { save: usdc(1_000), protect: usdc(300), sell: usdc(300), rebalance: usdc(500), entry: usdc(1_000) },
    capMaxRaw: usdc(10_000),
    numbers: defaultNumbers(rebalanceOptions()),
    rebalanceDay: 0,
    plan: null,
    ...over,
  };
}

describe("agentNexts: each agent's rule on live data", () => {
  it("is Protect's and Rebalance's only: earning and converting other dollars have no line (D20)", () => {
    expect(Object.keys(agentNexts(input()))).toEqual(["protect", "rebalance"]);
  });

  it("Protect repays from savings only in Act, back to Watch, and says why it doesn't otherwise", () => {
    expect(agentNexts(input()).protect).toEqual({ idle: "Safe. Nothing to do." });
    expect(agentNexts(input({ debtUsd: 0 })).protect).toEqual({ idle: "Nothing owed. Nothing to do." });
    // $1,400 of power against $1,000 owed is 1.4: Watch is fine (Act is the line, 2026-10-15).
    expect(agentNexts(input({ debtUsd: 1_000 })).protect).toEqual({ idle: "Watch. Steps in only at Act" });
    // Against $1,300 it's 1.077 (Act); back to 1.2 needs $133.34, rounded up to the cent.
    const act = input({ debtUsd: 1_300 });
    expect(agentNexts(act).protect).toEqual({
      will: "repays $133.34 from your cash",
      would: "Would repay $133.34 from your cash",
    });
    expect(agentNexts({ ...act, savingsRaw: 0n }).protect).toEqual({ idle: "Act. No cash to repay with" });
    const used = {
      ...act.left,
      protect: [
        { token: USDC.address, leftRaw: 0n },
        { token: USDC.address, leftRaw: 0n },
      ],
    };
    expect(agentNexts({ ...act, left: used }).protect).toEqual({ idle: "Act. Today’s limit is used" });
  });

  it("shows the weekend heads-up as a card only: before the Friday freeze, in Watch, when a 15% drop would reach Act", () => {
    // Friday 2025-10-17 14:30 New York (18:30 UTC); $1,400 of power against $1,120 owed is 1.25 (Watch), 1.0625 after −15%.
    // The executor's nextFreeze: 20:00 New York, 00:00 UTC on Saturday.
    const fri = Date.UTC(2025, 9, 17, 18, 30) / 1000;
    const freezeAt = Date.UTC(2025, 9, 18, 0) / 1000;
    const at = (nowSec: number, debtUsd: number, over: Partial<NextInput> = {}) => ({
      ...input({ nowSec, debtUsd, ...over }),
      freezeAt,
    });
    const card = weekendCard(at(fri, 1_120));
    expect(card).toEqual({
      addUsd: 129,
      dropPct: 15,
      when: `at ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(freezeAt * 1000)}`,
    });
    // No move with it: Protect's line is still Watch's.
    expect(agentNexts(input({ nowSec: fri, debtUsd: 1_120 })).protect).toEqual({ idle: "Watch. Steps in only at Act" });
    expect(weekendCard(at(fri - 3 * 3600, 1_120))).toBeNull(); // 11:30: not yet
    expect(weekendCard(at(WED_NOON, 1_120))).toBeNull(); // a Wednesday
    expect(weekendCard(at(fri, 1_000))).toBeNull(); // 1.4: −15% leaves 1.19, still Watch
    expect(weekendCard(at(fri, 1_300))).toBeNull(); // in Act, Protect acts itself
    expect(weekendCard({ ...at(fri, 1_120), freezeAt: null })).toBeNull(); // the executor's calendar not read yet
  });

  it("follows the executor's calendar and window, not a fixed Friday: holidays, a freeze already on, a shorter window", () => {
    const wedFreeze = Date.UTC(2025, 9, 16, 0) / 1000; // Wednesday 20:00 New York, before a Thursday the executor holds
    expect(
      weekendCard({ ...input({ debtUsd: 1_120 }), nowSec: wedFreeze - 2 * 3600, freezeAt: wedFreeze }),
    ).toMatchObject({ addUsd: 129 });
    // Good Friday: prices are already held, so nextFreeze gives back the hour asked (not after now): no card.
    const goodFriday = Date.UTC(2026, 3, 3, 18, 30) / 1000;
    expect(weekendCard({ ...input({ nowSec: goodFriday, debtUsd: 1_120 }), freezeAt: goodFriday - 1_800 })).toBeNull();
    // The window is the executor's: with 3 hours, 14:30 is too early for a 20:00 freeze.
    const fri = Date.UTC(2025, 9, 17, 18, 30) / 1000;
    const short = { ...defaultNumbers(rebalanceOptions()), weekendWindowSec: 3 * 3600 };
    expect(
      weekendCard({
        ...input({ nowSec: fri, debtUsd: 1_120, numbers: short }),
        freezeAt: Date.UTC(2025, 9, 18, 0) / 1000,
      }),
    ).toBeNull();
    expect(beforeFreeze(100, 100, 3600)).toBe(false); // the freeze itself is not before it
    expect(beforeFreeze(99, 100, 3600)).toBe(true);
    expect(beforeFreeze(100 - 3601, 100, 3600)).toBe(false);
  });

  it("Rebalance checks its mix at the next window, trades when a stock breaks its band, and waits while the credit is in Act", () => {
    // Thursday 10:00 New York, in the viewer's own words.
    expect(agentNexts(input()).rebalance).toEqual({
      idle: `On target. Checks ${whenText(Date.UTC(2025, 9, 16, 14) / 1000, WED_NOON)}`,
    });
    expect(agentNexts(input({ mixBps: null })).rebalance).toEqual({ idle: "No mix yet" });
    // 60/40 against a 50/50 mix: Apple broke out by 10 points.
    const drifted = input({ holdings: [free(0, 6_000, 250), free(5, 4_000, 180)] });
    const n = agentNexts(drifted).rebalance;
    expect(n).toMatchObject({ would: expect.stringMatching(/^Would trade \$\d+(\.\d\d)?$/) });
    expect("will" in n && n.will).toMatch(/^trades \$\d+(\.\d\d)? (today|tomorrow) /);
    // Watch is fine for the Rebalancer too: GooseExecutor waits only below Protect's trigger, the Act line.
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
    // A Save (action 3, job 0) or a conversion (action 9, job 4) is under the hood: every agent reads its rule.
    expect(agentNexts(input({ plan: { action: 3, job: 0, amount: usdc(40), reason: 0, off: 0 } }))).toEqual(
      agentNexts(input()),
    );
    expect(agentNexts(input({ plan: { action: 9, job: 4, amount: usdc(119), reason: 0, off: 0 } }))).toEqual(
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
    // [action, job]: Prune Protect, Repay, Sell, Heads-up, Clear, Defer, Rebalance.
    const planned = (
      [
        [1, 1],
        [2, 1],
        [4, 2],
        [5, 2],
        [6, 2],
        [7, 2],
        [8, 3],
      ] as const
    ).map(([action, job]) => planNext({ action, job, amount: usdc(10), reason: 0, off: 1 })!);
    expect(planned.map((p) => p.agent)).toEqual([
      "protect",
      "protect",
      "protect",
      "protect",
      "protect",
      "protect",
      "rebalance",
    ]);
    const words = planned.map((p) => p.next);
    expect(words[0]).toEqual({ idle: "Stopping: a year has passed since you switched it on." });
    expect(words.slice(1).map((w) => ("will" in w ? w.will : w.idle))).toEqual([
      "repays $10 from your cash",
      "sells backing stock to repay $10",
      "sends you a heads-up before selling",
      "clears the heads-up",
      "finishes its last move",
      "trades $10",
    ]);
    for (const w of words)
      expect(JSON.stringify(w)).not.toMatch(/borrow|lock|permission|executor|upkeep|registry|spender|saving/i);
    // Save (job 0) and Entry (job 4), even a prune: nothing to say on the Agents tab.
    for (const [action, job] of [
      [3, 0],
      [1, 0],
      [9, 4],
      [1, 4],
    ] as const) {
      expect(planNext({ action, job, amount: usdc(10), reason: 0, off: 1 })).toBeNull();
    }
  });
});

describe("the Rebalancer's next window", () => {
  it("counts New York days as the executor's calendar does", () => {
    expect(nyDay(WED_NOON)).toBe(Date.UTC(2025, 9, 15) / 86_400_000);
    // 02:00 UTC Thursday is still Wednesday evening in New York.
    expect(nyDay(Date.UTC(2025, 9, 16, 2) / 1000)).toBe(Date.UTC(2025, 9, 15) / 86_400_000);
  });

  it("is 10:00 New York on the next weekday whose window hasn't passed or run", () => {
    const at = (y: number, m: number, d: number, utcHour: number) => Date.UTC(y, m, d, utcHour) / 1000;
    // Wednesday noon: today's window has passed, so Thursday 10:00 (14:00 UTC, daylight time).
    expect(rebalanceCheckAt(WED_NOON, 0)).toBe(at(2025, 9, 16, 14));
    // Wednesday 9:00: today, unless it already traded today.
    expect(rebalanceCheckAt(at(2025, 9, 15, 13), 0)).toBe(at(2025, 9, 15, 14));
    expect(rebalanceCheckAt(at(2025, 9, 15, 13), nyDay(WED_NOON))).toBe(at(2025, 9, 16, 14));
    // Friday afternoon: Monday.
    expect(rebalanceCheckAt(at(2025, 9, 17, 20), 0)).toBe(at(2025, 9, 20, 14));
    // Standard time in December: 15:00 UTC.
    expect(rebalanceCheckAt(at(2025, 11, 3, 12), 0)).toBe(at(2025, 11, 3, 15));
  });

  it("says when in the viewer's own day", () => {
    expect(whenText(WED_NOON + 3600, WED_NOON)).toMatch(/^today /);
    expect(whenText(WED_NOON + 86_400, WED_NOON)).toMatch(/^tomorrow /);
    expect(whenText(WED_NOON + 5 * 86_400, WED_NOON)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
  });
});

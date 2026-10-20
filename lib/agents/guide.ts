import { CASH_AGENT, PROTECT_SELL, REBALANCER } from "@/config/risk";
import { WINDOW } from "@/lib/agents/next";

/*
 * The Agents tab's "How it works" sheet (Adrian, 2026-10-20, board 7m, its words through the no-AI-slop pass): how
 * Protect and Rebalance work, in plain words. Every number comes from the settings the agents run on, so the sheet stays
 * true when one changes. Pure, so the tests check the words.
 */

/** KeeperHub's round runs every 10 minutes (workflow q5vdv47dieyabhg4toiue, cron every 10 minutes). */
export const RUNNER_EVERY_MIN = 10;

const hf = (x: number) => x.toFixed(2);
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const clock = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
/** The room's share of a target, as the note says it. */
const SHARE: Record<number, string> = { 0.2: "a fifth", 0.25: "a quarter", 0.1: "a tenth" };
/** The note's example target, in % of the mix, and its room in points. */
const EXAMPLE = 25;
const ROOM = Math.min(EXAMPLE * REBALANCER.bandOfTarget, REBALANCER.bandMaxPoints);

export const AGENTS_GUIDE = {
  button: "How it works",
  title: "How your agents work",
  lead: "Two agents look after your account for you.",
  protect: {
    tag: "Keeps your credit safe",
    steps: [
      `It checks your credit health every ${RUNNER_EVERY_MIN} minutes.`,
      `Under ${hf(CASH_AGENT.triggerHf)}, it repays from your cash.`,
      "If your cash isn’t enough, it sells some stock and repays with that.",
      `It stops once your credit is back at ${hf(CASH_AGENT.targetHf)}.`,
    ],
    note: `It sells only the stocks you allow, at most ${pct(PROTECT_SELL.floorBps)} under the market price. It can’t move money out of your account.`,
  },
  rebalance: {
    tag: "Keeps your mix on target",
    steps: [
      "You pick how much of each stock you want.",
      `Once a market day, at ${clock(WINDOW.hour)} New York, it checks your stocks.`,
      "When one moves past its room, it sells some of what grew and buys what fell, so your mix is back on target.",
    ],
    note: `Each stock’s room is ${SHARE[REBALANCER.bandOfTarget] ?? `${REBALANCER.bandOfTarget * 100}%`} of its target, at most ${REBALANCER.bandMaxPoints} points, so a ${EXAMPLE}% target trades above ${EXAMPLE + ROOM}% or below ${EXAMPLE - ROOM}%. It trades at most ${pct(REBALANCER.floorBps)} under the market price, only with stock that isn’t backing your credit, and waits while your credit is in Act.`,
  },
  both: "Each agent turns on with one Face ID and off any time. Everything they do, and why, shows in Activity.",
  done: "Got it",
} as const;

import { describe, expect, it } from "vitest";
import { CASH_AGENT, PROTECT_SELL, REBALANCER } from "@/config/risk";
import { AGENTS_GUIDE, RUNNER_EVERY_MIN } from "@/lib/agents/guide";

const words = JSON.stringify(AGENTS_GUIDE);

describe("the Agents tab's How it works sheet (board 7m)", () => {
  it("says the numbers the agents run on", () => {
    expect(AGENTS_GUIDE.protect.steps).toEqual([
      `It checks your credit health every ${RUNNER_EVERY_MIN} minutes.`,
      "Under 1.03, it repays from your cash.",
      "If your cash isn’t enough, it sells some stock and repays with that.",
      "It stops once your credit is back at 1.12.",
    ]);
    expect(CASH_AGENT.triggerHf).toBe(1.03);
    expect(CASH_AGENT.targetHf).toBe(1.12);
    expect(AGENTS_GUIDE.protect.note).toContain(`at most ${PROTECT_SELL.floorBps / 100}% under the market price`);
    expect(AGENTS_GUIDE.rebalance.note).toContain("Each stock’s band is a fifth of its target, at most 5 points");
    expect(AGENTS_GUIDE.rebalance.note).toContain("a 25% target trades above 30% or below 20%");
    expect(AGENTS_GUIDE.rebalance.note).toContain(`at most ${REBALANCER.floorBps / 100}% under the market price`);
  });

  it("says the Rebalancer trades at most once a day, or on a new mix, with no fixed hour (decisions 4 and 7)", () => {
    expect(AGENTS_GUIDE.rebalance.steps).toEqual([
      "You pick how much of each stock you want.",
      "It trades at most once a day, or on a new mix.",
      "When one moves past its band, it sells some of what grew and buys what fell, so your mix is back on target.",
    ]);
    expect(words).not.toMatch(/market day|weekend|New York/);
  });

  it("keeps to the app's words: no borrow, locked or room, no protocol names, no em dashes", () => {
    expect(words).not.toMatch(/borrow|locked|\broom\b|aave|aerodrome|keeperhub|—/i);
  });
});

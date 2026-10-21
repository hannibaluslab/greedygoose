import { describe, expect, it } from "vitest";
import { CASH_AGENT, PROTECT_SELL, REBALANCER } from "@/config/risk";
import { AGENTS_GUIDE, rebalanceSteps, RUNNER_EVERY_MIN } from "@/lib/agents/guide";

/** Wednesday 2025-10-15 12:00 New York (16:00 UTC): today's check has passed, the next is Thursday 10:00 New York. */
const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;
const words = JSON.stringify([AGENTS_GUIDE, rebalanceSteps(WED_NOON), rebalanceSteps(0)]);

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

  it("says the Rebalancer's check on the viewer's clock with its GMT offset (Adrian, 2026-10-21)", () => {
    // Intl may put a narrow space before AM or PM: read any space as one.
    const at = (zone: string) => rebalanceSteps(WED_NOON, zone)[1].replace(/\s/g, " ");
    expect(at("Asia/Beirut")).toBe("Once a market day, at 5 PM GMT+3, it checks your stocks.");
    expect(at("UTC")).toBe("Once a market day, at 2 PM GMT, it checks your stocks.");
    expect(at("Asia/Kolkata")).toBe("Once a market day, at 7:30 PM GMT+5:30, it checks your stocks.");
    expect(at("America/New_York")).toBe("Once a market day, at 10 AM GMT-4, it checks your stocks.");
    // A week New York has changed its clocks and London hasn't yet (2026-03-09): 10:00 New York is 2 PM in London.
    expect(rebalanceSteps(Date.UTC(2026, 2, 9, 12) / 1000, "Europe/London")[1].replace(/\s/g, " ")).toBe(
      "Once a market day, at 2 PM GMT, it checks your stocks.",
    );
    // Before the clock is read, New York's own time.
    expect(rebalanceSteps(0)[1]).toBe("Once a market day, at 10:00 AM New York, it checks your stocks.");
  });

  it("keeps to the app's words: no borrow, locked or room, no protocol names, no em dashes", () => {
    expect(words).not.toMatch(/borrow|locked|\broom\b|aave|aerodrome|keeperhub|—/i);
  });
});

import { describe, expect, it } from "vitest";
import { agentList, mixOnTarget, type AgentListInput } from "@/lib/agents/list";
import type { AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";

const jobs = (s: AgentStatus): Record<AgentJob, AgentStatus> => ({ save: s, protect: s, sell: s, rebalance: s, entry: s });
const noCaps: Record<AgentJob, bigint | null> = { save: null, protect: null, sell: null, rebalance: null, entry: null };
const list = (over: Partial<AgentListInput>) => agentList({ status: jobs("off"), capRaw: noCaps, credit: "safe", onTarget: null, ...over });
const pills = (over: Partial<AgentListInput>) => list(over).agents.map((a) => `${a.agent}: ${a.pill.text}`);

describe("agentList (the Agents board's list)", () => {
  it("shows every agent Not live yet, with one line on why, while no executor is configured", () => {
    const l = list({ status: jobs("unconfigured") });
    expect(l.agents.map((a) => [a.agent, a.pill, a.sub])).toEqual([
      ["Rebalancer", { text: "Not live yet", tone: "neutral" }, "Keeps your mix · sells up to $500 a week"],
      ["Cash Agent", { text: "Not live yet", tone: "neutral" }, "Guards your credit · sells up to $300 a day"],
      ["Entry agent", { text: "Not live yet", tone: "neutral" }, "Other dollars to cash · 99.5% or better"],
    ]);
    expect(l.reason).toBe("Switching on opens after the agents' audit.");
    expect(l.agents.map((a) => a.href)).toEqual(["/manage", "/manage/credit", "/manage/entry"]);
  });

  it("shows the credit's own status on the Cash Agent once Protect guards it, as the board's Safe", () => {
    const on = { ...jobs("off"), save: "on", protect: "on", sell: "on" } as const;
    expect(list({ status: on }).agents[1].pill).toEqual({ text: "Safe", tone: "on" });
    expect(list({ status: on, credit: "watch" }).agents[1].pill).toEqual({ text: "Watch", tone: "watch" });
    expect(list({ status: on, credit: "act" }).agents[1].pill).toEqual({ text: "Act", tone: "act" });
    expect(list({ status: on, credit: "none" }).agents[1].pill).toEqual({ text: "On", tone: "on" });
    expect(list({ status: { ...jobs("off"), save: "on" } }).agents[1].pill).toEqual({ text: "On", tone: "on" });
    expect(list({ status: on }).reason).toBeNull();
  });

  it("reads each limit from the grant once it's on, and says Protect only repays when selling is off", () => {
    const status = { ...jobs("on"), sell: "off" } as const;
    const capRaw = { save: 1_000_000_000n, protect: 250_000_000n, sell: null, rebalance: 750_000_000n, entry: 2_000_000_000n };
    expect(list({ status, capRaw, onTarget: true }).agents.map((a) => a.sub)).toEqual([
      "Keeps your mix · sells up to $750 a week",
      "Guards your credit · repays up to $250 a day",
      "Other dollars to cash · up to $2,000 a day",
    ]);
    expect(list({ status: jobs("on"), capRaw: { ...capRaw, sell: 400_000_000n } }).agents[1].sub).toBe("Guards your credit · sells up to $400 a day");
  });

  it("shows the Rebalancer on or off target, or with no mix yet, and the in-between states", () => {
    expect(pills({ status: jobs("on"), onTarget: true })[0]).toBe("Rebalancer: On target");
    expect(pills({ status: jobs("on"), onTarget: false })[0]).toBe("Rebalancer: Off target");
    expect(pills({ status: jobs("on"), onTarget: null })[0]).toBe("Rebalancer: No mix yet");
    expect(pills({ status: jobs("starting") })).toEqual(["Rebalancer: Starting", "Cash Agent: Starting", "Entry agent: Starting"]);
    expect(pills({ status: jobs("loading") })).toEqual(["Rebalancer: …", "Cash Agent: …", "Entry agent: …"]);
    expect(pills({})).toEqual(["Rebalancer: Off", "Cash Agent: Off", "Entry agent: Off"]);
  });
});

describe("mixOnTarget (the Rebalancer's band)", () => {
  // 50/50 NVIDIA and Apple, both priced $100.
  const mix = [5000n, 0n, 0n, 0n, 0n, 5000n, 0n];
  const prices = [100e8, 0, 0, 0, 0, 100e8, 0].map(BigInt);
  const shares = (apple: number, nvidia: number) => [apple, 0, 0, 0, 0, nvidia, 0].map((s) => BigInt(Math.round(s * 1e8)));

  it("is on target inside the band (the smaller of 20% of the target and 5 points) and off past it", () => {
    expect(mixOnTarget(mix, shares(5, 5), prices)).toBe(true);
    expect(mixOnTarget(mix, shares(4.6, 5.4), prices)).toBe(true); // 54%: 4 points off
    expect(mixOnTarget(mix, shares(4.4, 5.6), prices)).toBe(false); // 56%: 6 points off
  });

  it("has no answer without a mix", () => {
    expect(mixOnTarget(mix.map(() => 0n), shares(5, 5), prices)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_COPY,
  AGENTS,
  agentItems,
  agentOf,
  agentParam,
  agentStatus,
  nextLine,
  NOT_LIVE,
  PROTECT_RULE,
  protectWarnings,
  TAB_JOBS,
  type Next,
} from "@/lib/agents/list";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";

const jobs = (s: AgentStatus): Record<AgentJob, AgentStatus> => ({
  save: s,
  protect: s,
  sell: s,
  rebalance: s,
  entry: s,
});
const none = Object.fromEntries(JOBS.map((j) => [j, null])) as Record<AgentJob, null>;
const idle = (idle: string): Next => ({ idle });
const repays: Next = { will: "repays $40 from your cash", would: "Would repay $40 from your cash" };
const nexts = { protect: repays, rebalance: idle("No mix yet") };

/** Every word a person can read on the tab and its sheets, for the word checks. */
const ON_SCREEN = /borrow|lock|permission|executor|upkeep|registry|spender|saving/i;

describe("the two agents", () => {
  it("are Protect and Rebalance, each saying what it does in under six words and what it never does", () => {
    const items = agentItems({ status: jobs("off"), capRaw: none, next: nexts });
    expect(items.map((i) => [i.name, i.does])).toEqual([
      ["Protect", "Steps in under 1.03"],
      ["Rebalance", "Keeps your mix on target"],
    ]);
    // Protect's line (Adrian, 2026-10-19): Protect steps in only under 1.03 and brings the credit back to 1.12.
    expect(PROTECT_RULE).toBe("Steps in only if your credit falls under 1.03, and brings it back to 1.12.");
    expect(AGENT_COPY.protect.lead.startsWith(PROTECT_RULE)).toBe(true);
    expect(AGENT_COPY.protect.never).toBe(
      "Protect does nothing until your credit falls under 1.03. It never sells a stock that doesn’t back your credit, and never sells on a weekend.",
    );
    expect(Object.values(AGENT_COPY.protect).join(" ")).not.toMatch(/keeps your credit safe/i);
    for (const a of AGENTS) {
      expect(AGENT_COPY[a].does.split(" ").length).toBeLessThan(6);
      expect(AGENT_COPY[a].never).toMatch(/never/);
      expect(Object.values(AGENT_COPY[a]).join(" ")).not.toMatch(ON_SCREEN);
    }
    expect(NOT_LIVE).not.toMatch(ON_SCREEN);
  });

  it("starts the Rebalancer on its limit and shows the grant's once it has one; Protect has no amount limit", () => {
    expect(agentItems({ status: jobs("off"), capRaw: none, next: nexts }).map((i) => i.limit)).toEqual([
      null,
      "Limit $100 a week",
    ]);
    // Protect's grant is at the executor's CAP_MAX: no chip, whatever it holds.
    const capRaw = { ...none, protect: 5_000_000n, rebalance: 1_234_000_000n };
    const items = agentItems({ status: jobs("on"), capRaw, next: nexts });
    expect(items.map((i) => [i.limit, i.limitUsd])).toEqual([
      [null, null],
      ["Limit $1,234 a week", 1_234],
    ]);
  });

  it("leaves earning and converting other dollars off the tab: no agent runs them, and turning all off spares them (D20)", () => {
    expect(agentOf("save")).toBeNull();
    expect(agentOf("entry")).toBeNull();
    expect(agentOf("sell")).toBe("protect");
    expect(TAB_JOBS).toEqual(["protect", "sell", "rebalance"]);
  });

  it("reads Protect from both its jobs: on when either runs", () => {
    expect(agentStatus("protect", { ...jobs("off"), sell: "on" })).toBe("on");
    expect(agentStatus("protect", { ...jobs("off"), protect: "starting" })).toBe("starting");
    expect(agentStatus("protect", { ...jobs("on"), sell: "loading" })).toBe("loading");
    expect(agentStatus("rebalance", jobs("unconfigured"))).toBe("unconfigured");
    expect(agentStatus("rebalance", { ...jobs("on"), rebalance: "off" })).toBe("off");
  });

  it("says what's next for an agent that runs, what it would do for one that doesn't, and why there's nothing", () => {
    expect(nextLine("on", repays)).toBe("Next: repays $40 from your cash");
    expect(nextLine("off", repays)).toBe("Would repay $40 from your cash");
    expect(nextLine("unconfigured", repays)).toBe("Would repay $40 from your cash");
    expect(nextLine("starting", repays)).toBe("Starting");
    expect(nextLine("loading", repays)).toBe("…");
    expect(nextLine("on", idle("Safe. Nothing to do."))).toBe("Safe. Nothing to do.");
    const items = agentItems({ status: { ...jobs("on"), rebalance: "off" }, capRaw: none, next: nexts });
    expect(items.map((i) => [i.on, i.line])).toEqual([
      [true, "Next: repays $40 from your cash"],
      [false, "No mix yet"],
    ]);
  });
});

describe("protectWarnings: the credit's warnings, with Top up and Repay, in Protect's sheet", () => {
  it("says nothing when all is fine", () => {
    expect(protectWarnings({ act: null, weekend: null })).toEqual([]);
  });

  it("warns in Act, saying whether Protect is on to step in at 1.03, then the weekend", () => {
    const [act, weekend] = protectWarnings({
      act: { addUsd: 120, protectOn: true },
      weekend: { addUsd: 129, dropPct: 15, when: "at 8:00 PM" },
    });
    expect(act).toMatchObject({
      key: "act",
      tone: "act",
      text: "Your credit is in Act.",
      sub: "Protect steps in at 1.03. Repaying $120 now brings it back to Watch.",
    });
    expect(weekend).toMatchObject({
      key: "weekend",
      tone: "watch",
      text: "Prices pause at 8:00 PM. If stocks reopen 15% lower, Aave can sell part of them.",
      sub: "Repaying $129 now keeps your credit over Aave’s line.",
    });
    for (const c of [act, weekend])
      expect(c.actions).toEqual([
        { kind: "sheet", label: "Top up", sheet: "top-up" },
        { kind: "sheet", label: "Repay", sheet: "repay" },
      ]);
    expect(protectWarnings({ act: { addUsd: 5, protectOn: false }, weekend: null })[0].sub).toBe(
      "Protect is off. Repaying $5 now brings it back to Watch.",
    );
  });
});

describe("agentParam (/agents?agent=…)", () => {
  it("names one of the two agents, and nothing else: Save's and Receive's old links open the tab", () => {
    expect(AGENTS.map(agentParam)).toEqual([...AGENTS]);
    expect([null, "", "Protect", "sell", "entry", "manage", "save", "receive"].map(agentParam)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

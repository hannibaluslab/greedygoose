import { describe, expect, it } from "vitest";
import {
  AGENTS,
  agentItems,
  agentOf,
  agentParam,
  agentStatus,
  nextLine,
  NOT_LIVE,
  protectWarnings,
  TAB_JOBS,
  type Next,
} from "@/lib/agents/list";
import { DEFAULT_PROTECT } from "@/lib/agents/lines";
import type { AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";

const jobs = (s: AgentStatus): Record<AgentJob, AgentStatus> => ({
  save: s,
  protect: s,
  sell: s,
  rebalance: s,
  entry: s,
});
const idle = (idle: string): Next => ({ idle });
const repays: Next = { will: "repays $40 from your cash", would: "Would repay $40 from your cash" };
const nexts = { protect: repays, rebalance: idle("No mix yet") };

/** Every word a person can read on the tab and its sheets, for the word checks. */
const ON_SCREEN = /borrow|lock|permission|executor|upkeep|registry|spender|saving/i;

describe("the two agents", () => {
  it("are Protector and Rebalancer, each saying what it does in under six words and what it never does", () => {
    const items = agentItems({ status: jobs("off"), next: nexts });
    expect(items.map((i) => [i.name, i.does])).toEqual([
      ["Protector", "Steps in under 1.03"],
      ["Rebalancer", "Keeps your mix on target"],
    ]);
    // Protect's line (Adrian, 2026-10-19): Protect steps in only under 1.03 and brings the credit back to 1.12.
    const [protect] = items;
    expect(protect.lead).toBe(
      "Steps in only if your credit falls under 1.03, and brings it back to 1.12. It repays from your cash, and can sell backing stock if cash isn’t enough.",
    );
    expect(protect.never).toBe(
      "Protector does nothing until your credit falls under 1.03. It never sells a stock that doesn’t back your credit.",
    );
    expect([protect.does, protect.lead, protect.never].join(" ")).not.toMatch(/keeps your credit safe/i);
    for (const item of items) {
      expect(item.does.split(" ").length).toBeLessThan(6);
      expect(item.never).toMatch(/never/);
      expect([item.does, item.lead, item.never].join(" ")).not.toMatch(ON_SCREEN);
    }
    expect(NOT_LIVE).not.toMatch(ON_SCREEN);
  });

  it("names the account's own line and target once it set them (decision 3)", () => {
    const [protect] = agentItems({ status: jobs("on"), next: nexts, protect: { line: 1.1, target: 1.2 } });
    expect(protect.does).toBe("Steps in under 1.10");
    expect(protect.lead.startsWith("Steps in only if your credit falls under 1.10, and brings it back to 1.20.")).toBe(
      true,
    );
    expect(protect.never).toMatch(/until your credit falls under 1\.10\./);
  });

  it("leaves earning and converting other dollars off the tab: no agent runs them, and turning all off spares them (D20)", () => {
    expect(agentOf("save")).toBeNull();
    expect(agentOf("entry")).toBeNull();
    expect(agentOf("sell")).toBe("protect");
    expect(TAB_JOBS).toEqual(["protect", "sell", "rebalance"]);
  });

  it("reads Protector from both its jobs: on when either runs", () => {
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
    const items = agentItems({ status: { ...jobs("on"), rebalance: "off" }, next: nexts });
    expect(items.map((i) => [i.on, i.line])).toEqual([
      [true, "Next: repays $40 from your cash"],
      [false, "No mix yet"],
    ]);
  });
});

describe("protectWarnings: the credit's warnings, with Top up and Repay, in Protector's sheet", () => {
  it("says nothing when all is fine", () => {
    expect(protectWarnings({ act: null, weekend: null })).toEqual([]);
  });

  it("warns in Act, saying whether Protector is on to step in at 1.03, then the weekend", () => {
    const [act, weekend] = protectWarnings({
      act: { addUsd: 120, protectOn: true, protect: DEFAULT_PROTECT },
      weekend: { addUsd: 129, dropPct: 15, when: "at 8:00 PM" },
    });
    expect(act).toMatchObject({
      key: "act",
      tone: "act",
      text: "Your credit is in Act.",
      sub: "Protector steps in at 1.03. Repaying $120 now brings it back to Watch.",
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
    expect(
      protectWarnings({ act: { addUsd: 5, protectOn: false, protect: DEFAULT_PROTECT }, weekend: null })[0].sub,
    ).toBe("Protector is off. Repaying $5 now brings it back to Watch.");
    // The account's own numbers: its line, and a target under Act named as a number, not "Watch".
    expect(
      protectWarnings({ act: { addUsd: 5, protectOn: true, protect: { line: 1.05, target: 1.1 } }, weekend: null })[0]
        .sub,
    ).toBe("Protector steps in at 1.05. Repaying $5 now brings it back to Watch.");
    expect(
      protectWarnings({ act: { addUsd: 5, protectOn: true, protect: { line: 1.03, target: 1.08 } }, weekend: null })[0]
        .sub,
    ).toBe("Protector steps in at 1.03. Repaying $5 now brings it back to 1.08.");
  });
});

describe("agentParam (/agents?agent=…)", () => {
  it("names one of the two agents, and nothing else: Save's and Receive's old links open the tab", () => {
    expect(AGENTS.map(agentParam)).toEqual([...AGENTS]);
    expect([null, "", "Protector", "sell", "entry", "manage", "save", "receive"].map(agentParam)).toEqual([
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

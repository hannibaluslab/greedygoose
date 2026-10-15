import { describe, expect, it } from "vitest";
import {
  AGENT_COPY,
  AGENTS,
  agentCards,
  agentItems,
  agentOf,
  agentParam,
  agentStatus,
  nextLine,
  NOT_LIVE,
  TAB_JOBS,
  type CardsInput,
  type Next,
} from "@/lib/agents/list";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";

const jobs = (s: AgentStatus): Record<AgentJob, AgentStatus> => ({ save: s, protect: s, sell: s, rebalance: s, entry: s });
const none = Object.fromEntries(JOBS.map((j) => [j, null])) as Record<AgentJob, null>;
const idle = (idle: string): Next => ({ idle });
const repays: Next = { will: "repays $40 from your cash", would: "Would repay $40 from your cash" };
const nexts = { protect: repays, rebalance: idle("No mix yet") };
const NOW = 1_760_000_000;
const DAY = 86_400;

/** Every word a person can read on the tab and its sheets, for the word checks. */
const ON_SCREEN = /borrow|lock|permission|executor|upkeep|registry|spender|saving/i;

describe("the two agents", () => {
  it("are Protect and Rebalance, each saying what it does in under six words and what it never does", () => {
    const items = agentItems({ status: jobs("off"), capRaw: none, next: nexts });
    expect(items.map((i) => [i.name, i.does])).toEqual([
      ["Protect", "Keeps your credit Safe"],
      ["Rebalance", "Keeps your mix on target"],
    ]);
    for (const a of AGENTS) {
      expect(AGENT_COPY[a].does.split(" ").length).toBeLessThan(6);
      expect(AGENT_COPY[a].never).toMatch(/never/);
      expect(Object.values(AGENT_COPY[a]).join(" ")).not.toMatch(ON_SCREEN);
    }
    expect(NOT_LIVE).not.toMatch(ON_SCREEN);
  });

  it("starts each on its limit, reading as a limit, and shows the grant's once it has one", () => {
    expect(agentItems({ status: jobs("off"), capRaw: none, next: nexts }).map((i) => i.limit)).toEqual(["Limit $100 a day", "Limit $100 a week"]);
    const capRaw = { ...none, protect: 25_000_000n, rebalance: 1_234_000_000n };
    expect(agentItems({ status: jobs("on"), capRaw, next: nexts }).map((i) => i.limit)).toEqual(["Limit $25 a day", "Limit $1,234 a week"]);
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

describe("agentCards: only when something needs the user", () => {
  const calm: CardsInput = {
    nowSec: NOW,
    headsUp: null,
    status: jobs("on"),
    ends: { save: NOW + 200 * DAY, protect: NOW + 200 * DAY, sell: NOW + 200 * DAY, rebalance: NOW + 200 * DAY, entry: NOW + 200 * DAY },
    stopped: none,
    fails: 0,
    cooldownUntil: 0,
  };

  it("shows nothing when all is fine", () => {
    expect(agentCards(calm)).toEqual([]);
  });

  it("says the heads-up in one sentence, with Add cash and Repay", () => {
    const [c] = agentCards({ ...calm, headsUp: { status: "watch", addUsd: 120, sellUsd: 180, when: "at 3:42 PM" } });
    expect(c).toMatchObject({ tone: "watch", agent: "Protect", text: "Your credit hit Watch. Add $120, or Protect sells $180 at 3:42 PM." });
    expect(c.actions).toEqual([
      { kind: "sheet", label: "Add cash", sheet: "top-up" },
      { kind: "sheet", label: "Repay", sheet: "repay" },
    ]);
    expect(agentCards({ ...calm, headsUp: { status: "act", addUsd: 5, sellUsd: 9, when: "when prices reopen" } })[0].text).toBe(
      "Your credit hit Act. Add $5, or Protect sells $9 when prices reopen.",
    );
  });

  it("offers Renew for an agent that stopped on its own, and not once it's back on", () => {
    const stopped = { ...calm, status: { ...jobs("on"), rebalance: "off" as const }, stopped: { ...none, rebalance: NOW - 2 * DAY } };
    const [c] = agentCards(stopped);
    expect(c.text).toMatch(/^Rebalance stopped on \w{3} \d{1,2}\. Switch it back on\?$/);
    expect(c.actions).toEqual([{ kind: "renew", agent: "rebalance", jobs: ["rebalance"] }]);
    expect(agentCards({ ...stopped, status: jobs("on") })).toEqual([]);
  });

  it("has no card for earning or other dollars: those grants are asked on Home (D20)", () => {
    const quiet = { ...calm, status: { ...jobs("on"), save: "off" as const, entry: "off" as const }, stopped: { ...none, save: NOW - DAY, entry: NOW - DAY } };
    expect(agentCards({ ...quiet, ends: { ...calm.ends, save: NOW + DAY, entry: NOW + DAY } })).toEqual([]);
  });

  it("warns a week before a grant ends, naming the agent once for both of Protect's", () => {
    const soon = { ...calm, ends: { ...calm.ends, protect: NOW + 5 * DAY, sell: NOW + 6 * DAY } };
    const [c] = agentCards(soon);
    expect(c.text).toMatch(/^Protect stops on \w{3} \d{1,2}\.$/);
    expect(c.actions).toEqual([{ kind: "renew", agent: "protect", jobs: ["protect", "sell"] }]);
    expect(agentCards({ ...calm, ends: { ...calm.ends, rebalance: NOW + 8 * DAY } })).toEqual([]);
  });

  it("says when runs keep failing, from three in a row", () => {
    expect(agentCards({ ...calm, fails: 2 })).toEqual([]);
    const [c] = agentCards({ ...calm, fails: 3, cooldownUntil: NOW + 1200 });
    expect(c.text).toBe("Your agents’ last 3 runs didn’t go through. Nothing moved.");
    expect(c.sub).toMatch(/^They try again at \d{1,2}:\d{2} [AP]M\. At 8 in a row they stop, and you can switch them back on here\.$/);
  });

  it("says nothing of failed runs while neither agent runs: they were earning's or converting's (D20)", () => {
    const cashOnly = { ...calm, status: { ...jobs("off"), save: "on" as const, entry: "on" as const }, ends: { ...calm.ends, protect: null, sell: null, rebalance: null } };
    expect(agentCards({ ...cashOnly, fails: 5 })).toEqual([]);
  });

  it("puts the heads-up first, then failures, stopped and stopping soon", () => {
    const everything: CardsInput = {
      ...calm,
      headsUp: { status: "watch", addUsd: 1, sellUsd: 1, when: "now" },
      status: { ...jobs("on"), rebalance: "off" },
      ends: { ...calm.ends, rebalance: null, protect: NOW + DAY },
      stopped: { ...none, rebalance: NOW - DAY },
      fails: 4,
    };
    expect(agentCards(everything).map((c) => c.key)).toEqual(["heads-up", "fails", "stopped-rebalance", "expiring-protect"]);
    for (const c of agentCards(everything)) expect(`${c.text} ${c.sub ?? ""}`).not.toMatch(ON_SCREEN);
  });
});

describe("agentParam (/agents?agent=…)", () => {
  it("names one of the two agents, and nothing else: Save's and Receive's old links open the tab", () => {
    expect(AGENTS.map(agentParam)).toEqual([...AGENTS]);
    expect([null, "", "Protect", "sell", "entry", "manage", "save", "receive"].map(agentParam)).toEqual([null, null, null, null, null, null, null, null]);
  });
});

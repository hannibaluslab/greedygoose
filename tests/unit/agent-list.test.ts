import { describe, expect, it } from "vitest";
import {
  AGENT_COPY,
  AGENTS,
  agentCards,
  agentItems,
  agentStatus,
  allOffCopy,
  confirmFor,
  nextLine,
  NOT_LIVE,
  type CardsInput,
  type Next,
} from "@/lib/agents/list";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";

const jobs = (s: AgentStatus): Record<AgentJob, AgentStatus> => ({ save: s, protect: s, sell: s, rebalance: s, entry: s });
const none = Object.fromEntries(JOBS.map((j) => [j, null])) as Record<AgentJob, null>;
const idle = (idle: string): Next => ({ idle });
const saves: Next = { will: "saves $40", would: "Would save $40" };
const nexts = { save: saves, protect: idle("Safe. Nothing to do."), rebalance: idle("No mix yet"), receive: idle("Nothing waiting") };
const NOW = 1_760_000_000;
const DAY = 86_400;

/** Every word a person can read on the tab and its sheets, for the word checks. */
const ON_SCREEN = /borrow|lock|permission|executor|upkeep|registry|spender/i;

describe("the four agents", () => {
  it("are Save, Protect, Rebalance and Receive, each saying what it does in under six words and what it never does", () => {
    const items = agentItems({ status: jobs("off"), capRaw: none, next: nexts });
    expect(items.map((i) => [i.name, i.does])).toEqual([
      ["Save", "Puts idle cash into savings"],
      ["Protect", "Keeps your credit Safe"],
      ["Rebalance", "Keeps your mix on target"],
      ["Receive", "Turns other dollars into cash"],
    ]);
    for (const a of AGENTS) {
      expect(AGENT_COPY[a].does.split(" ").length).toBeLessThan(6);
      expect(AGENT_COPY[a].never).toMatch(/never/);
      expect(Object.values(AGENT_COPY[a]).join(" ")).not.toMatch(ON_SCREEN);
    }
    expect(NOT_LIVE).not.toMatch(ON_SCREEN);
  });

  it("starts each on its limit, and shows the grant's once it has one", () => {
    expect(agentItems({ status: jobs("off"), capRaw: none, next: nexts }).map((i) => i.limit)).toEqual([
      "$1,000 a day",
      "$300 a day",
      "$500 a week",
      "$1,000 a day",
    ]);
    const capRaw = { ...none, save: 5_000_000_000n, protect: 100_000_000n };
    expect(agentItems({ status: jobs("on"), capRaw, next: nexts }).slice(0, 2).map((i) => i.limit)).toEqual(["$5,000 a day", "$100 a day"]);
  });

  it("reads Protect from both its jobs: on when either runs", () => {
    expect(agentStatus("protect", { ...jobs("off"), sell: "on" })).toBe("on");
    expect(agentStatus("protect", { ...jobs("off"), protect: "starting" })).toBe("starting");
    expect(agentStatus("protect", { ...jobs("on"), sell: "loading" })).toBe("loading");
    expect(agentStatus("save", jobs("unconfigured"))).toBe("unconfigured");
    expect(agentStatus("receive", jobs("off"))).toBe("off");
  });

  it("says what's next for an agent that runs, what it would do for one that doesn't, and why there's nothing", () => {
    expect(nextLine("on", saves)).toBe("Next: saves $40");
    expect(nextLine("off", saves)).toBe("Would save $40");
    expect(nextLine("unconfigured", saves)).toBe("Would save $40");
    expect(nextLine("starting", saves)).toBe("Starting");
    expect(nextLine("loading", saves)).toBe("…");
    expect(nextLine("on", idle("Safe. Nothing to do."))).toBe("Safe. Nothing to do.");
    const items = agentItems({ status: { ...jobs("on"), entry: "off" }, capRaw: none, next: nexts });
    expect(items.map((i) => [i.on, i.line])).toEqual([
      [true, "Next: saves $40"],
      [true, "Safe. Nothing to do."],
      [true, "No mix yet"],
      [false, "Nothing waiting"],
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
    waiting: [],
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
      { kind: "link", label: "Add cash", href: "/receive" },
      { kind: "link", label: "Repay", href: "/repay" },
    ]);
    expect(agentCards({ ...calm, headsUp: { status: "act", addUsd: 5, sellUsd: 9, when: "when prices reopen" } })[0].text).toBe(
      "Your credit hit Act. Add $5, or Protect sells $9 when prices reopen.",
    );
  });

  it("offers Renew for an agent that stopped on its own, and not once it's back on", () => {
    const stopped = { ...calm, status: { ...jobs("on"), save: "off" as const }, stopped: { ...none, save: NOW - 2 * DAY } };
    const [c] = agentCards(stopped);
    expect(c.text).toMatch(/^Save stopped on \w{3} \d{1,2}\. Switch it back on\?$/);
    expect(c.actions).toEqual([{ kind: "renew", agent: "save", jobs: ["save"] }]);
    expect(agentCards({ ...stopped, status: jobs("on") })).toEqual([]);
  });

  it("warns a week before a grant ends, naming the agent once for both of Protect's", () => {
    const soon = { ...calm, ends: { ...calm.ends, protect: NOW + 5 * DAY, sell: NOW + 6 * DAY } };
    const [c] = agentCards(soon);
    expect(c.text).toMatch(/^Protect stops on \w{3} \d{1,2}\.$/);
    expect(c.actions).toEqual([{ kind: "renew", agent: "protect", jobs: ["protect", "sell"] }]);
    expect(agentCards({ ...calm, ends: { ...calm.ends, save: NOW + 8 * DAY } })).toEqual([]);
  });

  it("says what coins are waiting and when they're tried again", () => {
    const [c] = agentCards({ ...calm, waiting: [{ symbol: "USDT", amountRaw: 120_000_000n, retryAt: NOW + 3600 }] });
    expect(c.text).toMatch(/^\$120 USDT is waiting for a fair price\. Retrying at \d{1,2}:\d{2} [AP]M\.$/);
    expect(c.actions).toEqual([]);
  });

  it("says when runs keep failing, from three in a row", () => {
    expect(agentCards({ ...calm, fails: 2 })).toEqual([]);
    const [c] = agentCards({ ...calm, fails: 3, cooldownUntil: NOW + 1200 });
    expect(c.text).toBe("Your agents’ last 3 runs didn’t go through. Nothing moved.");
    expect(c.sub).toMatch(/^They try again at \d{1,2}:\d{2} [AP]M\. At 8 in a row they stop, and you can switch them back on here\.$/);
  });

  it("puts the heads-up first, then failures, stopped, stopping soon and waiting coins", () => {
    const everything: CardsInput = {
      ...calm,
      headsUp: { status: "watch", addUsd: 1, sellUsd: 1, when: "now" },
      status: { ...jobs("on"), save: "off" },
      ends: { ...calm.ends, save: null, protect: NOW + DAY },
      stopped: { ...none, save: NOW - DAY },
      waiting: [{ symbol: "USDe", amountRaw: 1_000_000n, retryAt: NOW + 60 }],
      fails: 4,
    };
    expect(agentCards(everything).map((c) => c.key)).toEqual(["heads-up", "fails", "stopped-save", "expiring-protect", "waiting-USDe"]);
    for (const c of agentCards(everything)) expect(`${c.text} ${c.sub ?? ""}`).not.toMatch(ON_SCREEN);
  });
});

describe("confirmFor: the confirm step, before JAW's own screen", () => {
  const until = NOW + 365 * DAY;
  it("says switching on is one Face ID, with the limit and how long it lasts", () => {
    const c = confirmFor({ kind: "on", agent: "save", limit: "$1,000 a day", untilSec: until, faceIds: 1 });
    expect(c).toMatchObject({ title: "Switch on Save", button: "Switch on with Face ID", note: "One Face ID" });
    expect(c.lead).toBe("Save puts idle cash into savings, up to $1,000 a day. JAW shows the limit on its own screen before you sign.");
    expect(c.rows).toEqual([
      { label: "Limit", value: "$1,000 a day" },
      { label: "Until", value: expect.stringMatching(/^\w{3} \d{1,2}, \d{4}$/) },
    ]);
  });

  it("counts a Face ID for each grant turning off takes, and names the change of limit", () => {
    expect(confirmFor({ kind: "off", agent: "protect", limit: "$300 a day", untilSec: until, faceIds: 2 }).note).toBe(
      "2 Face IDs, one for each limit you signed",
    );
    expect(confirmFor({ kind: "limit", agent: "save", limit: "$5,000 a day", from: "$1,000 a day", untilSec: until, faceIds: 1 }).rows[0]).toEqual({
      label: "Limit",
      value: "$1,000 a day → $5,000 a day",
    });
    expect(confirmFor({ kind: "renew", agent: "receive", limit: "$1,000 a day", untilSec: until, faceIds: 1 }).title).toBe("Renew Receive");
    expect(allOffCopy(4)).toMatchObject({ title: "Turn off all agents", note: "4 Face IDs, one for each limit you signed" });
  });

  it("uses none of the words the screens leave out", () => {
    for (const agent of AGENTS) {
      for (const kind of ["on", "off", "limit", "renew"] as const) {
        const c = confirmFor({ kind, agent, limit: "$1 a day", from: "$2 a day", untilSec: until, faceIds: 1 });
        expect([c.title, c.lead, c.button, c.note, ...c.rows.map((r) => r.value)].join(" ")).not.toMatch(ON_SCREEN);
      }
    }
  });
});

import { CASH_AGENT } from "@/config/risk";
import type { AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";
import { clockText } from "@/lib/clock";
import { formatUsdTrim } from "@/lib/formatting";

/*
 * The Agents tab (Adrian, 2026-10-15): two agents, each a switch and a "next" line (neither has an amount limit), and
 * cards only when something needs the user. Pure, so the dev gallery draws every state with the app's own words.
 *
 * Earning and turning other dollars into cash (the Save and Entry jobs) run under the hood (D20): they have no row,
 * no sheet and no switch here. Their grants are asked where they matter, on Home and Pay (lib/cashSetup.ts).
 */

/** The two agents, in the tab's order. */
export const AGENTS = ["protect", "rebalance"] as const;
export type Agent = (typeof AGENTS)[number];

/**
 * The executor's jobs each agent runs. Protect is two grants: repaying from cash, and selling backing stock, which has
 * its own switch inside Protect's sheet (decision 5). The first job is the one the agent's switch grants.
 */
export const AGENT_JOBS: Record<Agent, readonly [AgentJob, ...AgentJob[]]> = {
  protect: ["protect", "sell"],
  rebalance: ["rebalance"],
};

/** The jobs the Agents tab switches: Protect's two and the Rebalancer's ("Turn off all agents" covers these). */
export const TAB_JOBS: readonly AgentJob[] = AGENTS.flatMap((a) => AGENT_JOBS[a]);

/** The agent that runs `job`; null for Save and Entry, which have no agent on screen (D20). */
export const agentOf = (job: AgentJob): Agent | null => AGENTS.find((a) => AGENT_JOBS[a].includes(job)) ?? null;

/** The agent a link names (`/agents?agent=protect`), or null for anything else. */
export const agentParam = (value: string | null): Agent | null => AGENTS.find((a) => a === value) ?? null;

/** Who made a move in the activity: an agent, or "Agents" for a run that didn't go through. */
export type AgentName = "Protect" | "Rebalance" | "Agents";
export const AGENT_NAME: Record<Agent, Exclude<AgentName, "Agents">> = {
  protect: "Protect",
  rebalance: "Rebalance",
};

/** Health factors as the app writes them: "1.03", "1.12". */
export const hfText = (hf: number) => hf.toFixed(2);
/** Protect's line and target as the copy names them (the deploy defaults, config/risk.ts CASH_AGENT): "1.03", "1.12". */
export const PROTECT_LINE = hfText(CASH_AGENT.triggerHf);
export const PROTECT_TARGET = hfText(CASH_AGENT.targetHf);
const LINE = PROTECT_LINE;
const TARGET = PROTECT_TARGET;

/**
 * Protect's rule in one line (Adrian, 2026-10-19: Protect's line is 1.03, Act is a warning only), wherever Protect is
 * named. Once it steps in, it goes on until the credit is back at the target.
 */
export const PROTECT_RULE = `Steps in only if your credit falls under ${LINE}, and brings it back to ${TARGET}.`;

/** What each agent does, in under six words for its row and in a line for its sheet, and what it never does. */
export const AGENT_COPY: Record<Agent, { does: string; lead: string; never: string }> = {
  protect: {
    does: `Steps in under ${LINE}`,
    lead: `${PROTECT_RULE} It repays from your cash, and can sell backing stock if cash isn’t enough.`,
    never: `Protect does nothing until your credit falls under ${LINE}. It never sells a stock that doesn’t back your credit, and never sells on a weekend.`,
  },
  rebalance: {
    does: "Keeps your mix on target",
    lead: "Once a market day, it sells what grew too big to buy what fell short.",
    never: "Rebalance never touches your cash or the stocks backing your credit.",
  },
};

/** An agent's state from its jobs': not live, loading, on (any job runs), starting, else off. */
export function agentStatus(agent: Agent, status: Readonly<Record<AgentJob, AgentStatus>>): AgentStatus {
  const s = AGENT_JOBS[agent].map((j) => status[j]);
  return (["unconfigured", "loading", "on", "starting"] as const).find((x) => s.includes(x)) ?? "off";
}

/**
 * What an agent does next, from the executor's `planOf` or its rule (lib/agents/next.ts): a move, said for an agent
 * that runs ("repays $40 from your cash") and for one that doesn't ("Would repay $40 from your cash"), or why there's
 * none ("Safe. Nothing to do.").
 */
export type Next = { will: string; would: string } | { idle: string };

/** The "next" line for an agent in `status`. */
export function nextLine(status: AgentStatus, next: Next): string {
  if (status === "loading") return "…";
  if (status === "starting") return "Starting";
  if ("idle" in next) return next.idle;
  return status === "on" ? `Next: ${next.will}` : next.would;
}

/** One agent's row on the Agents tab. */
export type AgentItem = {
  agent: Agent;
  name: Exclude<AgentName, "Agents">;
  does: string;
  status: AgentStatus;
  /** The switch: on while the agent runs or is starting. */
  on: boolean;
  line: string;
};

type AgentItemsInput = {
  status: Readonly<Record<AgentJob, AgentStatus>>;
  next: Readonly<Record<Agent, Next>>;
};

/** The two rows, with no limit on either. */
export function agentItems(i: AgentItemsInput): AgentItem[] {
  return AGENTS.map((agent) => {
    const status = agentStatus(agent, i.status);
    return {
      agent,
      name: AGENT_NAME[agent],
      does: AGENT_COPY[agent].does,
      status,
      on: status === "on" || status === "starting",
      line: nextLine(status, i.next[agent]),
    };
  });
}

/** One line under the rows while no agent can be switched on. */
export const NOT_LIVE = "Coming soon: the agents open once their automation is approved.";

/*
 * Cards: only when something needs the user, one sentence and one or two actions each.
 */

const YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
/** "Oct 15, 2027", for a grant's end a year out. */
export const longDateText = (sec: number) => YEAR.format(sec * 1000);
/** "11:00 PM GMT+3": a time ahead, on the viewer's clock with its GMT offset (Adrian, 2026-10-21). */
export const timeText = (sec: number) => clockText(sec);

/** A warning's button: the Top up or Repay sheet over the screen. */
export type CardAction = { kind: "sheet"; label: string; sheet: "top-up" | "repay" };

export type AgentCard = {
  key: string;
  /** A warning wears the credit's colour: Act's, or the weekend's Watch. */
  tone: "watch" | "act";
  agent: AgentName;
  text: string;
  sub?: string;
  actions: CardAction[];
};

/**
 * The Act warning (Adrian, 2026-10-19), from a plain health check (lib/agents/next.ts `actWarning`): credit in Act but
 * not yet under Protect's line, Protect on or off. A warning only: what repaying brings it back to Watch, and whether
 * Protect is on to step in at its line.
 */
export type ActCard = { addUsd: number; protectOn: boolean };

/**
 * The weekend card (lib/agents/rules/protect.ts `weekendHeadsUp`): no move, a card only. Before prices pause, credit
 * that a drop at the reopen would take under Aave's line: when they pause, the drop, and the repay that keeps it over.
 */
export type WeekendCard = { addUsd: number; dropPct: number; when: string };

/**
 * Protect's warnings, with their Top up and Repay, in Protect's sheet (Adrian, 2026-10-20: the Agents tab is an
 * overview, and every action lives in the sheet; Protect's card says the same in its pill and lines). Act first.
 */
export function protectWarnings(i: { act: ActCard | null; weekend: WeekendCard | null }): AgentCard[] {
  const money: CardAction[] = [
    { kind: "sheet", label: "Top up", sheet: "top-up" },
    { kind: "sheet", label: "Repay", sheet: "repay" },
  ];
  const cards: AgentCard[] = [];
  if (i.act)
    cards.push({
      key: "act",
      tone: "act",
      agent: "Protect",
      text: "Your credit is in Act.",
      sub: `${i.act.protectOn ? `Protect steps in at ${LINE}.` : "Protect is off."} Repaying ${formatUsdTrim(i.act.addUsd)} now brings it back to Watch.`,
      actions: money,
    });
  if (i.weekend)
    cards.push({
      key: "weekend",
      tone: "watch",
      agent: "Protect",
      text: `Prices pause ${i.weekend.when}. If stocks reopen ${i.weekend.dropPct}% lower, Aave can sell part of them.`,
      sub: `Repaying ${formatUsdTrim(i.weekend.addUsd)} now keeps your credit over Aave’s line.`,
      actions: money,
    });
  return cards;
}

/** What an agent's sheet can do, each a JAW grant or revoke on JAW's own sheet. */
export type SheetAction = "on" | "off" | "renew";

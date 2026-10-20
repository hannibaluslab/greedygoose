import { CASH_AGENT } from "@/config/risk";
import type { AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";
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
  /**
   * Always null: neither agent has an amount limit, so no row shows one and each switch grants at the executor's
   * CAP_MAX. The fields stay while the page's rows and switches still read them.
   */
  limit: null;
  limitUsd: null;
};

type AgentItemsInput = {
  status: Readonly<Record<AgentJob, AgentStatus>>;
  /** Each job's limit while it has a grant (on or starting), USDC units; null otherwise. Not read: no agent has one. */
  capRaw: Readonly<Record<AgentJob, bigint | null>>;
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
      limit: null,
      limitUsd: null,
    };
  });
}

/** One line under the rows while no agent can be switched on. */
export const NOT_LIVE = "Coming soon: the agents open once their automation is approved.";

/*
 * Cards: only when something needs the user, one sentence and one or two actions each.
 */

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dateText = (sec: number) => DATE.format(sec * 1000);
/** "Oct 15, 2027", for a grant's end a year out. */
export const longDateText = (sec: number) => YEAR.format(sec * 1000);
export const timeText = (sec: number) => TIME.format(sec * 1000);

/** A grant this close to its end gets a card. */
const EXPIRING_SEC = 7 * 86_400;
/** Failed runs in a row before a card says so (the executor switches the account off at eight). */
const FAILS_CARD = 3;
const MAX_FAILS = 8;

/**
 * A card's button: the Top up or Repay sheet over the tab, Renew (JAW's own sheet), or Finish (the registrations of
 * grants JAW made that the executor doesn't run yet, in one JAW sheet).
 */
export type CardAction =
  | { kind: "sheet"; label: string; sheet: "top-up" | "repay" }
  | { kind: "renew"; agent: Agent; jobs: AgentJob[] }
  | { kind: "finish" };

export type AgentCard = {
  key: string;
  /** The warnings wear the credit's colour (Act's, the weekend's Watch); the rest are plain. */
  tone: "watch" | "act" | "plain";
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

export type CardsInput = {
  nowSec: number;
  act: ActCard | null;
  /** Only while Protect runs (on or starting), as Weekend Shield did. */
  weekend: WeekendCard | null;
  status: Readonly<Record<AgentJob, AgentStatus>>;
  /** Each job's grant end while it has a live one (on or starting). */
  ends: Readonly<Record<AgentJob, number | null>>;
  /**
   * When each job stopped without the user turning it off: its grant ran out (JAW's list) or the executor switched it
   * off (`JobOff`, not revoked). Null when it didn't, or it has been switched on since.
   */
  stopped: Readonly<Record<AgentJob, number | null>>;
  /** Failed runs in a row, and when the executor tries again. */
  fails: number;
  cooldownUntil: number;
  /** Jobs JAW granted that the executor doesn't run yet: their registration didn't go through (useAgents `toFinish`). */
  finish: readonly AgentJob[];
};

/** What the Finish card calls each job: its agent, or what it does for the two that run under the hood (D20). */
const FINISH_NAME: Record<AgentJob, string> = {
  protect: "Protect",
  sell: "Protect",
  rebalance: "Rebalance",
  save: "Earning",
  entry: "Turning other dollars into cash",
};

/**
 * The Finish card: grants JAW made that the executor doesn't run yet (a registration sheet that didn't open, or was
 * cancelled, or the app was closed before it), each named once, and the one tap that registers them all.
 */
function finishCard(jobs: readonly AgentJob[]): AgentCard | null {
  if (jobs.length === 0) return null;
  const names = [...new Set(jobs.map((j) => FINISH_NAME[j]))];
  const agents = [...new Set(jobs.map(agentOf))];
  const one = names.length === 1;
  return {
    key: "finish",
    tone: "plain",
    agent: agents.length === 1 && agents[0] ? AGENT_NAME[agents[0]] : "Agents",
    text: `${one ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`} ${one ? "isn’t" : "aren’t"} running yet.`,
    sub: `One more Face ID finishes turning ${one ? "it" : "them"} on.`,
    actions: [{ kind: "finish" }],
  };
}

/** The cards, most urgent first: the warnings, agents still to finish, failed runs, stopped agents, agents about to stop. */
export function agentCards(i: CardsInput): AgentCard[] {
  const cards: AgentCard[] = [];
  if (i.act) {
    const a = i.act;
    cards.push({
      key: "act",
      tone: "act",
      agent: "Protect",
      text: "Your credit is in Act.",
      sub: `${a.protectOn ? `Protect steps in at ${LINE}.` : "Protect is off."} Repaying ${formatUsdTrim(a.addUsd)} now brings it back to Watch.`,
      actions: [
        { kind: "sheet", label: "Top up", sheet: "top-up" },
        { kind: "sheet", label: "Repay", sheet: "repay" },
      ],
    });
  }
  if (i.weekend) {
    const w = i.weekend;
    cards.push({
      key: "weekend",
      tone: "watch",
      agent: "Protect",
      text: `Prices pause ${w.when}. If stocks reopen ${w.dropPct}% lower, Aave can sell part of them.`,
      sub: `Repaying ${formatUsdTrim(w.addUsd)} now keeps your credit over Aave’s line.`,
      // As the Act warning's: the last action is the lime one, and here it is the repay the line names.
      actions: [
        { kind: "sheet", label: "Top up", sheet: "top-up" },
        { kind: "sheet", label: "Repay", sheet: "repay" },
      ],
    });
  }
  const finish = finishCard(i.finish);
  if (finish) cards.push(finish);
  // Runs fail for the whole account; with neither agent running, they were earning's or converting's (D20): no card.
  const running = AGENTS.some((a) => ["on", "starting"].includes(agentStatus(a, i.status)));
  if (i.fails >= FAILS_CARD && running) {
    const retry =
      i.cooldownUntil > i.nowSec ? `They try again at ${timeText(i.cooldownUntil)}` : "They try again on the next run";
    cards.push({
      key: "fails",
      tone: "plain",
      agent: "Agents",
      text: `Your agents’ last ${i.fails} runs didn’t go through. Nothing moved.`,
      sub: `${retry}. At ${MAX_FAILS} in a row they stop, and you can switch them back on here.`,
      actions: [],
    });
  }
  for (const agent of AGENTS) {
    if (agentStatus(agent, i.status) !== "off") continue;
    const jobs = AGENT_JOBS[agent].filter((j) => i.stopped[j] !== null);
    if (jobs.length === 0) continue;
    const at = Math.max(...jobs.map((j) => i.stopped[j]!));
    cards.push({
      key: `stopped-${agent}`,
      tone: "plain",
      agent: AGENT_NAME[agent],
      text: `${AGENT_NAME[agent]} stopped on ${dateText(at)}. Switch it back on?`,
      actions: [{ kind: "renew", agent, jobs }],
    });
  }
  for (const agent of AGENTS) {
    const jobs = AGENT_JOBS[agent].filter((j) => {
      const end = i.ends[j];
      return end !== null && end - i.nowSec <= EXPIRING_SEC;
    });
    if (jobs.length === 0) continue;
    const end = Math.min(...jobs.map((j) => i.ends[j]!));
    cards.push({
      key: `expiring-${agent}`,
      tone: "plain",
      agent: AGENT_NAME[agent],
      text: `${AGENT_NAME[agent]} stops on ${dateText(end)}.`,
      actions: [{ kind: "renew", agent, jobs }],
    });
  }
  return cards;
}

/** What an agent's sheet can do, each a JAW grant or revoke on JAW's own sheet. */
export type SheetAction = "on" | "off" | "renew";

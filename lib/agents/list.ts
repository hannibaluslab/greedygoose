import { LIMIT_USD, type AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";
import { formatUsdTrim } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";

/*
 * The Agents tab (Adrian, 2026-10-15): two agents, each a switch, a "next" line and a limit, and cards only when
 * something needs the user. Pure, so the dev gallery draws every state with the app's own words.
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

/** What each agent does, in under six words for its row and in a line for its sheet, and what it never does. */
export const AGENT_COPY: Record<Agent, { does: string; lead: string; never: string }> = {
  protect: {
    does: "Keeps your credit Safe",
    lead: "Repays from your cash when your credit leaves Safe. It can sell backing stock if cash isn’t enough.",
    never: "Protect never sells a stock that doesn’t back your credit, and never sells on a weekend.",
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

/** "$100 a day", "$100 a week". */
export const limitText = (usd: number, job: AgentJob) => `${formatUsdTrim(usd)} a ${LIMIT_USD[job].per}`;
const usdOf = (raw: bigint) => Number(raw) / 10 ** USDC.decimals;

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
  /** "Limit $100 a day": the grant's limit while it has one, the one it starts on otherwise. */
  limit: string;
  limitUsd: number;
};

export type AgentItemsInput = {
  status: Readonly<Record<AgentJob, AgentStatus>>;
  /** Each job's limit while it has a grant (on or starting), USDC units; null otherwise. */
  capRaw: Readonly<Record<AgentJob, bigint | null>>;
  next: Readonly<Record<Agent, Next>>;
};

/** The two rows. Each limit is the agent's own job's (Protect's: repaying from cash). */
export function agentItems(i: AgentItemsInput): AgentItem[] {
  return AGENTS.map((agent) => {
    const job = AGENT_JOBS[agent][0];
    const status = agentStatus(agent, i.status);
    const cap = i.capRaw[job];
    const limitUsd = cap === null ? LIMIT_USD[job].start : usdOf(cap);
    return {
      agent,
      name: AGENT_NAME[agent],
      does: AGENT_COPY[agent].does,
      status,
      on: status === "on" || status === "starting",
      line: nextLine(status, i.next[agent]),
      limit: `Limit ${limitText(limitUsd, job)}`,
      limitUsd,
    };
  });
}

/** One line under the rows while no agent can be switched on. */
export const NOT_LIVE = "Not live yet. Switching on opens after the agents’ audit.";

/*
 * Cards: only when something needs the user, one sentence and one or two actions each.
 */

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
export const dateText = (sec: number) => DATE.format(sec * 1000);
/** "Oct 15, 2027", for a grant's end a year out. */
export const longDateText = (sec: number) => YEAR.format(sec * 1000);
export const timeText = (sec: number) => TIME.format(sec * 1000);

/** A grant this close to its end gets a card. */
export const EXPIRING_SEC = 7 * 86_400;
/** Failed runs in a row before a card says so (the executor switches the account off at eight). */
export const FAILS_CARD = 3;
const MAX_FAILS = 8;

export type CardAction = { kind: "link"; label: string; href: string } | { kind: "renew"; agent: Agent; jobs: AgentJob[] };

export type AgentCard = {
  key: string;
  /** The heads-up wears the credit's colour; the rest are plain. */
  tone: "watch" | "act" | "plain";
  agent: AgentName;
  text: string;
  sub?: string;
  actions: CardAction[];
};

/** Protect · sell's pending heads-up, read live: what to add, what it would sell, and when. */
export type HeadsUpCard = { status: "watch" | "act"; addUsd: number; sellUsd: number; when: string };

export type CardsInput = {
  nowSec: number;
  headsUp: HeadsUpCard | null;
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
};

/** The cards, most urgent first: the heads-up, failed runs, stopped agents, agents about to stop. */
export function agentCards(i: CardsInput): AgentCard[] {
  const cards: AgentCard[] = [];
  if (i.headsUp) {
    const h = i.headsUp;
    cards.push({
      key: "heads-up",
      tone: h.status,
      agent: "Protect",
      text: `Your credit hit ${h.status === "act" ? "Act" : "Watch"}. Add ${formatUsdTrim(h.addUsd)}, or Protect sells ${formatUsdTrim(h.sellUsd)} ${h.when}.`,
      actions: [
        { kind: "link", label: "Add cash", href: "/receive" },
        { kind: "link", label: "Repay", href: "/repay" },
      ],
    });
  }
  // Runs fail for the whole account; with neither agent running, they were earning's or converting's (D20): no card.
  const running = AGENTS.some((a) => ["on", "starting"].includes(agentStatus(a, i.status)));
  if (i.fails >= FAILS_CARD && running) {
    const retry = i.cooldownUntil > i.nowSec ? `They try again at ${timeText(i.cooldownUntil)}` : "They try again on the next run";
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

/** What an agent's sheet can do, each a JAW grant or revoke on JAW's own sheet. Its limit is set in its body. */
export type SheetAction = "on" | "off" | "renew";

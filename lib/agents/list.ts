import { maxUint256 } from "viem";
import { MANAGE, type AgentName } from "@/lib/agents/feed";
import { LIMIT_USD, type AgentJob } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";
import { rebalanceTrades, type RebalanceOptions } from "@/lib/guardian/rebalance";
import { STATUS_LABEL, type Status } from "@/lib/risk/status";
import { USDC } from "@/lib/tokens/registry";
import { formatUsdTrim } from "@/lib/formatting";

/** An agent pill's colour: green when it's on and Safe (or on target), the credit's own Watch / Act, neutral otherwise. */
export type AgentTone = "on" | "watch" | "act" | "neutral";

/** One agent on the Agents board's list: its mark, state, one line with its limit, and where it's managed. */
export type AgentItem = {
  agent: AgentName;
  pill: { text: string; tone: AgentTone };
  sub: string;
  href: string;
  /** What the chevron opens, for screen readers (the board's "Open your mix"). */
  opens: string;
};

export type AgentListInput = {
  status: Readonly<Record<AgentJob, AgentStatus>>;
  /** Each job's limit once it's on, in USDC units (a week's for the Rebalancer). */
  capRaw: Readonly<Record<AgentJob, bigint | null>>;
  /** The credit's status: none when nothing is owed. */
  credit: Status;
  /** Whether the free stock sits in the Rebalancer's band; null when no mix is set or it can't be read yet. */
  onTarget: boolean | null;
};

const usd = (raw: bigint) => formatUsdTrim(Number(raw) / 10 ** USDC.decimals);
const usdOf = (raw: bigint | null, fallbackUsd: number) => (raw === null ? formatUsdTrim(fallbackUsd) : usd(raw));

/** The pill every agent shares until it's on: not live, loading, starting or off. */
function idle(statuses: AgentStatus[]): AgentItem["pill"] | null {
  if (statuses.includes("unconfigured")) return { text: "Not live yet", tone: "neutral" };
  if (statuses.includes("loading")) return { text: "…", tone: "neutral" };
  if (statuses.includes("on")) return null;
  return { text: statuses.includes("starting") ? "Starting" : "Off", tone: "neutral" };
}

const CREDIT_TONE: Record<Exclude<Status, "none">, AgentTone> = { safe: "on", watch: "watch", act: "act" };

/**
 * The Agents board's list, from the executor's registry and JAW's list (useAgents): the Rebalancer, the Cash Agent
 * (Save and Protect, with Protect's selling) and the Entry agent. With no executor every agent is "Not live yet", and
 * `reason` says in one line why none can be switched on.
 */
export function agentList(i: AgentListInput): { agents: AgentItem[]; reason: string | null } {
  const s = i.status;
  const guarding = s.protect === "on" || s.sell === "on";
  const cashPill =
    idle([s.save, s.protect, s.sell]) ??
    (guarding && i.credit !== "none" ? { text: STATUS_LABEL[i.credit], tone: CREDIT_TONE[i.credit] } : { text: "On", tone: "on" as const });
  const rebalancePill =
    idle([s.rebalance]) ??
    (i.onTarget === null ? { text: "No mix yet", tone: "neutral" as const } : i.onTarget ? { text: "On target", tone: "on" as const } : { text: "Off target", tone: "neutral" as const });
  const entryPill = idle([s.entry]) ?? { text: "On", tone: "on" as const };

  // With selling switched off alone (decision 5), Protect only repays.
  const guards =
    s.protect === "on" && s.sell !== "on"
      ? `repays up to ${usd(i.capRaw.protect!)} a day`
      : `sells up to ${usdOf(i.capRaw.sell, LIMIT_USD.sell.start)} a day`;

  return {
    agents: [
      {
        agent: "Rebalancer",
        pill: rebalancePill,
        sub: `Keeps your mix · sells up to ${usdOf(i.capRaw.rebalance, LIMIT_USD.rebalance.start)} a week`,
        href: MANAGE.mix.href,
        opens: "Open your mix",
      },
      { agent: "Cash Agent", pill: cashPill, sub: `Guards your credit · ${guards}`, href: MANAGE.protection.href, opens: "Open Protection's limits" },
      {
        agent: "Entry agent",
        pill: entryPill,
        // Every swap is at 99.5% of face value or better, a bound that can only tighten.
        sub: i.capRaw.entry === null ? "Other dollars to cash · 99.5% or better" : `Other dollars to cash · up to ${usd(i.capRaw.entry)} a day`,
        href: MANAGE.entry.href,
        opens: "Open the Entry agent",
      },
    ],
    reason: s.save === "unconfigured" ? "Switching on opens after the agents' audit." : null,
  };
}

/**
 * Whether the account's free stock sits inside the Rebalancer's band for its mix: no trade the rule would make, with
 * no limit in the way. The mix is in BPS and prices are Aave's, 8 decimals, both by reserve id; shares raw. `options`
 * are the rule's (`rebalanceOptions`). Null when no mix is set.
 */
export function mixOnTarget(
  mixBps: readonly number[],
  freeRaw: readonly bigint[],
  pricesRaw: readonly bigint[],
  options: RebalanceOptions,
): boolean | null {
  if (mixBps.every((w) => w === 0)) return null;
  const stocks = mixBps.map((w, r) => ({ sharesRaw: freeRaw[r], price: pricesRaw[r], weightBps: BigInt(w), sellLeftRaw: maxUint256 }));
  return rebalanceTrades({ stocks, usdcLeftRaw: maxUint256 }, options).length === 0;
}

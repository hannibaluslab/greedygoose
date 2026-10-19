import { decodeErrorResult, isAddressEqual, maxUint256, type Hex } from "viem";
import { CASH_AGENT } from "@/config/risk";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import type { AgentEvent } from "@/lib/agents/events";
import { PROTECT_LINE, PROTECT_TARGET, type AgentName } from "@/lib/agents/list";
import type { AgentJob } from "@/lib/agents/permissions";
import { statusFor, type Status } from "@/lib/risk/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { formatCoin, formatShares, formatUsdTrim } from "@/lib/formatting";

/** A line of the feed: plain words, and Safe / Watch / Act in their colour. */
export type Words = readonly (string | { status: Exclude<Status, "none"> })[];

/**
 * Whose move a row is: an agent's, or "Cash" for what happens to the cash under the hood (D20): money that arrives
 * starts earning, and other dollars become cash. Those read as money events, with no agent named.
 */
export type MoveBy = AgentName | "Cash";

/** One executor move as the feed draws it: who, one line on what changed, and the details on tap. */
export type AgentMove = {
  by: MoveBy;
  line: Words;
  details: { label: string; value: Words }[];
};

/**
 * What the chain said around a move, read at its block and the one before: what was owed, the cash (wallet plus
 * savings, D15), how much of the grant's limit the period had used after it (the Rebalancer's), and Aave's prices.
 * Each is optional: a row says less when a read fails.
 */
export type MoveContext = {
  /** USDC units owed, before and after. */
  owedRaw?: readonly [bigint, bigint];
  /** USDC units of cash, before and after. */
  cashRaw?: readonly [bigint, bigint];
  /** The grant's limit and what its period had used, in USDC units. */
  used?: { spentRaw: bigint; capRaw: bigint };
  /** Aave's price per stock, 8 decimals, by reserve id. */
  pricesRaw?: readonly bigint[];
};

/**
 * Which grant's limit an agent's move counts against ("Used this week"): the Rebalancer's only. Protect's moves show
 * none, as it has no amount limit (2026-10-19), and a cash event (a Save, a conversion) shows none either: those grants
 * run under the hood (D20).
 */
export function limitOf(e: AgentEvent): { job: AgentJob; spend: number } | null {
  return e.kind === "rebalanced" ? { job: "rebalance", spend: 0 } : null;
}

/** Whether a move's row reads what was owed and the cash around it. */
export const movesMoney = (e: AgentEvent) => e.kind === "repaid" || e.kind === "sold" || e.kind === "rebalanced";

/** GooseExecutor's BASE_COOLDOWN and MAX_FAILS (GooseExecutor.md §6): 10 minutes after a failed run, doubling, and off at eight. */
const FIRST_COOLDOWN_SEC = 600;
const MAX_FAILS = 8;

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const at = (sec: number) => TIME.format(sec * 1000);

const usd = (raw: bigint) => formatUsdTrim(Number(raw) / 10 ** USDC.decimals);
/** What's owed rounds up to the cent: it's never shown as less than it is. */
const owed = (raw: bigint) => formatUsdTrim(Math.ceil(Number(raw) / 10 ** (USDC.decimals - 2)) / 100);

/** A health factor (WAD; the max when nothing is owed) as Safe / Watch / Act, or none. */
const statusOf = (hf: bigint): Status => statusFor(hf === maxUint256 ? null : Number(hf) / 1e18);
const word = (hf: bigint): Words => {
  const s = statusOf(hf);
  return s === "none" ? ["Nothing owed"] : [{ status: s }];
};
/**
 * After a Protect move: "Back to Watch." (where Protect brings it, 1.12), "Back to Safe.", "Still in Act." when a move
 * was cut short, or "Nothing owed now."
 */
const after = (hf: bigint): Words => {
  const s = statusOf(hf);
  return s === "none"
    ? ["Nothing owed now."]
    : s === "act"
      ? ["Still in ", { status: s }, "."]
      : ["Back to ", { status: s }, "."];
};

/** "Tesla", "Tesla and Apple", "3 stocks". */
function names(reserveIds: number[]): string {
  const n = reserveIds.map((r) => EQUITIES[r].name);
  return n.length === 1 ? n[0] : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.length} stocks`;
}

const held = (shares: readonly bigint[]) => shares.flatMap((s, r) => (s > 0n ? [r] : []));

/** Shares worth at Aave's price, in USDC units; or what was traded in shares when there's no price. */
function worth(shares: readonly bigint[], prices: readonly bigint[] | undefined): string {
  const ids = held(shares);
  if (prices) return usd(ids.reduce((t, r) => t + (shares[r] * prices[r]) / 10n ** 10n, 0n));
  return ids.length === 1 ? `${formatShares(Number(shares[ids[0]]) / 1e8)} shares` : "some";
}

/** The cash a sale or a trade left: the swaps' extra over their floors stays in the wallet. */
function cashAfterTrade(ctx: MoveContext): Words {
  if (!ctx.cashRaw) return ["Not used"];
  const up = ctx.cashRaw[1] - ctx.cashRaw[0];
  return up >= 5_000n ? [`Not used · +${usd(up)}`] : ["Not touched"];
}

function owedRow(ctx: MoveContext) {
  return ctx.owedRaw ? [{ label: "You owe", value: [`${owed(ctx.owedRaw[0])} → ${owed(ctx.owedRaw[1])}`] }] : [];
}

/** The Rebalancer's "Used this week": Protect has no amount limit, so its moves have no such row. */
function usedRow(ctx: MoveContext) {
  if (!ctx.used) return [];
  const { spentRaw, capRaw } = ctx.used;
  return [{ label: "Used this week", value: [`${usd(spentRaw)} of ${usd(capRaw)}`] }];
}

/**
 * Why Protect moved: the credit fell under its line, or a rescue it started went on (above the line, under the target)
 * until the credit was back at the target.
 */
const protectWhy = (hfBefore: bigint): Words =>
  Number(hfBefore) / 1e18 < CASH_AGENT.triggerHf
    ? [`Your credit fell under ${PROTECT_LINE}.`]
    : [`Protect went on until ${PROTECT_TARGET}.`];

/**
 * An agent job's name in a sentence, and the agent its rows sit under. Save and Entry are switched on once, where they
 * matter, and their switches make no row (D20). Protect's two have no amount limit, so their lines name none.
 */
const JOB: Partial<Record<AgentJob, { agent: AgentName; on: (cap: string) => string; off: string }>> = {
  protect: {
    agent: "Protect",
    on: () => `Protect is on. If your credit falls under ${PROTECT_LINE}, it repays from your cash.`,
    off: "Protect is off",
  },
  sell: {
    agent: "Protect",
    on: () => "Protect can sell backing stock.",
    off: "Protect won’t sell",
  },
  rebalance: { agent: "Rebalance", on: (cap) => `Rebalance is on, up to ${cap} a week.`, off: "Rebalance is off" },
};

/** Why a job was switched off, after its name ("Save is off: …"). */
export const OFF_WHY = {
  revoked: ".",
  expired: ": a year has passed since you switched it on.",
  "not-owner": ": it can no longer act on your account.",
  stuck: ": its last runs didn’t go through.",
} as const;

/** A failed run's reason in GooseExecutor's own words (its error's name), or the raw code. */
function errorName(reason: Hex): string {
  try {
    return decodeErrorResult({ abi: gooseExecutorAbi, data: reason }).errorName;
  } catch {
    return reason;
  }
}

function coin(address: `0x${string}`) {
  return ENTRY_COINS.find((c) => isAddressEqual(c.address, address));
}
const coinAmount = (raw: bigint, decimals: number) => formatCoin(Number(raw) / 10 ** decimals);

/** Protect repaid from the cash: how much, the status it brought, and why. */
function repaidMove(e: Extract<AgentEvent, { kind: "repaid" }>, ctx: MoveContext): AgentMove {
  return {
    by: "Protect",
    line: [`Repaid ${usd(e.amountRaw)} from your cash. `, ...after(e.hfAfter)],
    details: [
      { label: "Why", value: protectWhy(e.hfBefore) },
      ...owedRow(ctx),
      { label: "Status", value: [...word(e.hfBefore), " → ", ...word(e.hfAfter)] },
      // Cash is savings (D15): the repay came from it (plan §6's "From your cash: $X", in the board's 82px label).
      { label: "My cash", value: [`${usd(e.amountRaw)} used`] },
    ],
  };
}

/** Protect sold backing stock to repay: what and how much, the status it brought, and why. */
function soldMove(e: Extract<AgentEvent, { kind: "sold" }>, ctx: MoveContext): AgentMove {
  return {
    by: "Protect",
    line: [`Sold ${worth(e.sharesRaw, ctx.pricesRaw)} of ${names(held(e.sharesRaw))} to repay. `, ...after(e.hfAfter)],
    details: [
      { label: "Why", value: protectWhy(e.hfBefore) },
      ...owedRow(ctx),
      { label: "Status", value: [...word(e.hfBefore), " → ", ...word(e.hfAfter)] },
      { label: "My cash", value: cashAfterTrade(ctx) },
    ],
  };
}

/**
 * The Agents board's words for one executor event at `time` (seconds). Plain words and dollars, no health factor but
 * Protect's line and target (D17's words too); null for what isn't a move from the user's side: a run deferred to the
 * next block, Save's and Entry's switches, and a coin waiting for a fair price (the Cash card says it's arriving).
 */
export function describeAgentEvent(e: AgentEvent, time: number, ctx: MoveContext = {}): AgentMove | null {
  switch (e.kind) {
    case "job-on": {
      const j = JOB[e.job];
      return j
        ? {
            by: j.agent,
            line: [j.on(usd(e.capRaw))],
            details: [{ label: "Until", value: [DATE.format(e.end * 1000)] }],
          }
        : null;
    }
    case "job-off": {
      const j = JOB[e.job];
      return j ? { by: j.agent, line: [j.off + OFF_WHY[e.reason]], details: [] } : null;
    }
    case "saved":
      // Cash is savings (D15), and earning is under the hood (D20): a Save reads as the money arriving.
      return {
        by: "Cash",
        line: [`${usd(e.amountRaw)} added to your cash.`],
        details: [{ label: "Why", value: ["Money that arrives in your account earns with the rest of your cash."] }],
      };
    case "repaid":
      return repaidMove(e, ctx);
    case "sold":
      return soldMove(e, ctx);
    case "keep-mix":
      return {
        by: "Protect",
        line: [e.on ? "Will sell the same share of each stock." : "Will sell for the most safety per dollar."],
        details: [],
      };
    case "mix": {
      const set = e.weightsBps.flatMap((w, r) => (w > 0 ? [[r, w] as const] : [])).sort((a, b) => b[1] - a[1]);
      return {
        by: "Rebalance",
        line: [
          set.length
            ? `Your mix: ${set.map(([r, w]) => `${EQUITIES[r].name} ${w / 100}%`).join(", ")}.`
            : "Your mix is cleared.",
        ],
        details: [],
      };
    }
    case "rebalanced":
      return {
        by: "Rebalance",
        line: [
          `Sold ${worth(e.soldRaw, ctx.pricesRaw)} of ${names(held(e.soldRaw))}, bought ${worth(e.boughtRaw, ctx.pricesRaw)} of ${names(held(e.boughtRaw))}.`,
        ],
        details: [
          { label: "Why", value: ["Your mix drifted too far from its target."] },
          { label: "My cash", value: cashAfterTrade(ctx) },
          ...usedRow(ctx),
        ],
      };
    case "rebalance-skipped":
      return {
        by: "Rebalance",
        line: ["Prices were off today, so it didn’t trade."],
        details: [
          { label: "Why", value: ["Each trade must get close to Aave’s price. It tries again next market day."] },
        ],
      };
    case "converted": {
      // Other dollars becoming cash is under the hood (D20): it reads as the money arriving.
      const c = coin(e.coin);
      return {
        by: "Cash",
        line: [
          `${c ? `${coinAmount(e.amountInRaw, c.decimals)} ${c.symbol}` : "A dollar coin"} arrived as ${usd(e.usdcOutRaw)} cash.`,
        ],
        details: [
          { label: "Why", value: ["Dollars other than USDC become cash, at 99.5% of face value or better."] },
          { label: "My cash", value: [`+${usd(e.usdcOutRaw)}`] },
        ],
      };
    }
    case "entry-waiting":
    case "run-deferred":
      return null;
    case "run-failed":
      return {
        by: "Agents",
        line: ["A run didn’t go through. Nothing moved."],
        details: [
          ...(e.fails < MAX_FAILS
            ? [{ label: "Tries again", value: [at(time + (FIRST_COOLDOWN_SEC << (e.fails - 1)))] }]
            : []),
          { label: "In a row", value: [String(e.fails)] },
          { label: "Code", value: [errorName(e.reason)] },
        ],
      };
  }
}

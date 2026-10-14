import { decodeErrorResult, isAddressEqual, maxUint256, type Hex } from "viem";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import type { AgentEvent } from "@/lib/agents/events";
import type { AgentName } from "@/lib/agents/list";
import type { AgentJob } from "@/lib/agents/permissions";
import { marketState } from "@/lib/market-hours";
import { statusFor, type Status } from "@/lib/risk/status";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { formatShares, formatUsdTrim } from "@/lib/formatting";

/** A line of the feed: plain words, and Safe / Watch / Act in their colour. */
export type Words = readonly (string | { status: Exclude<Status, "none"> })[];

/** One agent move as the Agents tab draws it: who, one line on what changed, and the details on tap. */
export type AgentMove = {
  agent: AgentName;
  line: Words;
  details: { label: string; value: Words }[];
};

/**
 * What the chain said around a move, read at its block and the one before: what was owed, the cash (wallet plus
 * savings, D15), how much of the grant's limit the period had used after it, and Aave's prices. Each is optional: a
 * row says less when a read fails.
 */
export type MoveContext = {
  /** USDC units owed, before and after. */
  owedRaw?: readonly [bigint, bigint];
  /** USDC units of cash, before and after. */
  cashRaw?: readonly [bigint, bigint];
  /** The grant's limit and what its period had used, in the limit's token units (`decimals`). */
  used?: { spentRaw: bigint; capRaw: bigint; decimals: number };
  /** Aave's price per stock, 8 decimals, by reserve id. */
  pricesRaw?: readonly bigint[];
};

/** Which grant's limit a move counts against, and which of its limits: the coin's own for Entry. */
export function limitOf(e: AgentEvent): { job: AgentJob; spend: number } | null {
  switch (e.kind) {
    case "saved":
      return { job: "save", spend: 0 };
    case "repaid":
      return { job: "protect", spend: 0 };
    case "sold":
      return { job: "sell", spend: 0 };
    case "rebalanced":
      return { job: "rebalance", spend: 0 };
    case "converted": {
      const i = ENTRY_COINS.findIndex((c) => isAddressEqual(c.address, e.coin));
      return i < 0 ? null : { job: "entry", spend: i };
    }
    default:
      return null;
  }
}

/** Whether a move's row reads what was owed and the cash around it. */
export const movesMoney = (e: AgentEvent) => e.kind === "repaid" || e.kind === "sold" || e.kind === "rebalanced";

/** GooseExecutor's BASE_COOLDOWN and MAX_FAILS (GooseExecutor.md §6): 10 minutes after a failed run, doubling, and off at eight. */
const FIRST_COOLDOWN_SEC = 600;
const MAX_FAILS = 8;

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const at = (sec: number) => TIME.format(sec * 1000);

const usd = (raw: bigint, decimals = USDC.decimals) => formatUsdTrim(Number(raw) / 10 ** decimals);
/** What's owed rounds up to the cent: it's never shown as less than it is. */
const owed = (raw: bigint) => formatUsdTrim(Math.ceil(Number(raw) / 10 ** (USDC.decimals - 2)) / 100);

/** A health factor (WAD; the max when nothing is owed) as Safe / Watch / Act, or none. */
const statusOf = (hf: bigint): Status => statusFor(hf === maxUint256 ? null : Number(hf) / 1e18);
const word = (hf: bigint): Words => {
  const s = statusOf(hf);
  return s === "none" ? ["Nothing owed"] : [{ status: s }];
};
/** "Back to Safe." after a move, "Now Watch." if it's not there yet, or "Nothing owed now." */
const after = (hf: bigint): Words => {
  const s = statusOf(hf);
  return s === "none" ? ["Nothing owed now."] : s === "safe" ? ["Back to ", { status: s }, "."] : ["Now ", { status: s }, "."];
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

function usedRow(ctx: MoveContext, per: "today" | "this week") {
  if (!ctx.used) return [];
  const { spentRaw, capRaw, decimals } = ctx.used;
  return [{ label: per === "today" ? "Used today" : "Used this week", value: [`${usd(spentRaw, decimals)} of ${usd(capRaw, decimals)}`] }];
}

/** A job's name in a sentence, and the agent its rows sit under. */
const JOB: Record<AgentJob, { agent: AgentName; on: (cap: string) => string; off: string }> = {
  save: { agent: "Save", on: (cap) => `Save is on, up to ${cap} a day.`, off: "Save is off" },
  protect: { agent: "Protect", on: (cap) => `Protect is on. It repays from your cash, up to ${cap} a day.`, off: "Protect is off" },
  sell: { agent: "Protect", on: (cap) => `Protect can sell backing stock, up to ${cap} a day.`, off: "Protect won't sell" },
  rebalance: { agent: "Rebalance", on: (cap) => `Rebalance is on, up to ${cap} a week.`, off: "Rebalance is off" },
  entry: { agent: "Receive", on: (cap) => `Receive is on, up to ${cap} a day.`, off: "Receive is off" },
};

/** Why a job was switched off, after its name ("Save is off: …"). */
export const OFF_WHY = {
  revoked: ".",
  expired: ": a year has passed since you switched it on.",
  "not-owner": ": it can no longer act on your account.",
  stuck: ": its last runs didn't go through.",
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
const coinAmount = (raw: bigint, decimals: number) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The Agents board's words for one executor event at `time` (seconds). Plain words and dollars, no health factor
 * (D17's words too); null for what isn't a move from the user's side (a run deferred to the next block).
 */
export function describeAgentEvent(e: AgentEvent, time: number, ctx: MoveContext = {}): AgentMove | null {
  switch (e.kind) {
    case "job-on":
      return { agent: JOB[e.job].agent, line: [JOB[e.job].on(usd(e.capRaw))], details: [{ label: "Until", value: [DATE.format(e.end * 1000)] }] };
    case "job-off":
      return { agent: JOB[e.job].agent, line: [JOB[e.job].off + OFF_WHY[e.reason]], details: [] };
    case "saved":
      return {
        // Cash is savings (D15): a Save folds into the money arriving.
        agent: "Save",
        line: [`${usd(e.amountRaw)} added to your cash.`],
        details: [{ label: "Why", value: ["Money that lands in your wallet goes into savings, where it earns."] }, ...usedRow(ctx, "today")],
      };
    case "repaid":
      return {
        agent: "Protect",
        line: [`Repaid ${usd(e.amountRaw)} from your cash. `, ...after(e.hfAfter)],
        details: [
          {
            label: "Why",
            value:
              e.reason === "weekend"
                ? ["Prices pause for the weekend. Protect made room in case they reopen lower."]
                : ["Your credit reached ", ...word(e.hfBefore), "."],
          },
          ...owedRow(ctx),
          { label: "Status", value: [...word(e.hfBefore), " → ", ...word(e.hfAfter)] },
          // Cash is savings (D15): the repay came from it (plan §6's "From your cash: $X", in the board's 82px label).
          { label: "Your cash", value: [`${usd(e.amountRaw)} used`] },
          ...usedRow(ctx, "today"),
        ],
      };
    case "sold":
      return {
        agent: "Protect",
        line: [`Sold ${worth(e.sharesRaw, ctx.pricesRaw)} of ${names(held(e.sharesRaw))} to repay. `, ...after(e.hfAfter)],
        details: [
          {
            label: "Why",
            value: e.atOnce
              ? ["Your credit reached ", ...word(e.hfBefore), ", so Protect sold at once."]
              : ["Your credit was still in ", ...word(e.hfBefore), " after the heads-up."],
          },
          ...owedRow(ctx),
          { label: "Status", value: [...word(e.hfBefore), " → ", ...word(e.hfAfter)] },
          { label: "Your cash", value: cashAfterTrade(ctx) },
          ...usedRow(ctx, "today"),
        ],
      };
    case "heads-up":
      return {
        agent: "Protect",
        line: ["Credit reached ", ...word(e.hf), ". Asked you to repay or add more."],
        details: [
          { label: "Why", value: ["Your cash couldn't bring it back to ", { status: "safe" }, "."] },
          { label: "Would sell", value: [`${usd(e.sellValueRaw)} of backing stock`] },
          // A wait that ends while prices are held gives their reopening as the sale time: the second before is closed.
          { label: "Sells at", value: [marketState(new Date((e.sellAfter - 1) * 1000)).open ? at(e.sellAfter) : "When prices reopen"] },
        ],
      };
    case "heads-up-cleared":
      return { agent: "Protect", line: ["Credit recovered. Nothing was sold."], details: [{ label: "Status", value: word(e.hf) }] };
    case "keep-mix":
      return {
        agent: "Protect",
        line: [e.on ? "Will sell the same share of each stock." : "Will sell for the most safety per dollar."],
        details: [],
      };
    case "mix": {
      const set = e.weightsBps.flatMap((w, r) => (w > 0 ? [[r, w] as const] : [])).sort((a, b) => b[1] - a[1]);
      return {
        agent: "Rebalance",
        line: [set.length ? `Your mix: ${set.map(([r, w]) => `${EQUITIES[r].name} ${w / 100}%`).join(", ")}.` : "Your mix is cleared."],
        details: [],
      };
    }
    case "rebalanced":
      return {
        agent: "Rebalance",
        line: [
          `Sold ${worth(e.soldRaw, ctx.pricesRaw)} of ${names(held(e.soldRaw))}, bought ${worth(e.boughtRaw, ctx.pricesRaw)} of ${names(held(e.boughtRaw))}.`,
        ],
        details: [
          { label: "Why", value: ["Your mix drifted too far from its target."] },
          { label: "Your cash", value: cashAfterTrade(ctx) },
          ...usedRow(ctx, "this week"),
        ],
      };
    case "rebalance-skipped":
      return {
        agent: "Rebalance",
        line: ["Prices were off today, so it didn't trade."],
        details: [{ label: "Why", value: ["Each trade must get close to Aave's price. It tries again next market day."] }],
      };
    case "converted": {
      const c = coin(e.coin);
      return {
        agent: "Receive",
        line: [`Turned ${c ? `${coinAmount(e.amountInRaw, c.decimals)} ${c.symbol}` : "a stablecoin"} into ${usd(e.usdcOutRaw)} of cash.`],
        details: [
          { label: "Why", value: ["Dollars other than USDC become cash, at 99.5% or better."] },
          { label: "Your cash", value: [`+${usd(e.usdcOutRaw)}`] },
          ...usedRow(ctx, "today"),
        ],
      };
    }
    case "entry-waiting": {
      const c = coin(e.coin);
      return {
        agent: "Receive",
        line: [`${c ? `${coinAmount(e.amountInRaw, c.decimals)} ${c.symbol}` : "A stablecoin"} is waiting: the price was under 99.5%.`],
        details: [
          { label: "Why", value: ["It only swaps at 99.5% of face value or better."] },
          { label: "Tries again", value: [at(e.retryAt)] },
        ],
      };
    }
    case "run-failed":
      return {
        agent: "Agents",
        line: ["A run didn't go through. Nothing moved."],
        details: [
          ...(e.fails < MAX_FAILS ? [{ label: "Tries again", value: [at(time + (FIRST_COOLDOWN_SEC << (e.fails - 1)))] }] : []),
          { label: "In a row", value: [String(e.fails)] },
          { label: "Code", value: [errorName(e.reason)] },
        ],
      };
    case "run-deferred":
      return null;
  }
}

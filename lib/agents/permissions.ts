import { isAddressEqual, maxUint160, zeroAddress, type Address, type Hex } from "viem";
import type { PermissionsDetail } from "@jaw.id/wagmi";
import { AAVE } from "@/lib/aave/addresses";
import { PROTOCOLS, SEL } from "@/lib/protocols/config";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { CASH_COINS } from "@/lib/tokens/stables";

/** A grant lasts a year: its end is its start plus this, and the allowlist approves no other window. */
export const GRANT_SECONDS = 365 * 86_400;

/** PeriodUnit enum in JustaPermissionManager (JustaPermissionManager.sol:206-213). There is no Year. */
export const PERIOD = { Minute: 0, Hour: 1, Day: 2, Week: 3, Month: 4, Forever: 5 } as const;

/**
 * Every allowance in every agent grant: the largest a JAW spend limit holds. No agent has an amount limit, the live
 * test included (decision 9, 2026-10-22): each is bounded by what GooseGuard lets it do, not by how much.
 */
export const NO_LIMIT = maxUint160;

export type JawPermission = {
  account: `0x${string}`;
  spender: `0x${string}`;
  start: number;
  end: number;
  salt: bigint;
  calls: { target: `0x${string}`; selector: Hex; checker: `0x${string}` }[];
  spends: { token: `0x${string}`; allowance: bigint; unit: number; multiplier: number }[];
};

/** The agents' jobs, in GooseGuard's order: the index is the job's id on-chain (`register`, `permissionOf`). */
export const JOBS = ["save", "protect", "sell", "rebalance", "entry"] as const;
export type AgentJob = (typeof JOBS)[number];
/** The Cash Agent's two jobs (the Agents switches): one USDC spend a day each, with no limit. */
export const CASH_JOBS = ["save", "protect"] as const;
type CashJob = (typeof CASH_JOBS)[number];
/** The jobs whose grant names the stocks it may sell: Protect · sell (a day) and the Rebalancer (a week). */
type StockJob = "sell" | "rebalance";

/**
 * What each job may call, in the order the app has always granted them. JAW's screen grants every call with checker 0
 * (D14), so the manager pins no argument: GooseGuard builds each call for the account alone and checks the result.
 */
const CALLS: Record<CashJob, readonly { target: Address; selector: Hex }[]> = {
  save: [
    { target: USDC.address, selector: SEL.approve },
    { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.supply },
  ],
  protect: [
    { target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.withdraw },
    { target: USDC.address, selector: SEL.approve },
    { target: AAVE.SPOKE, selector: SEL.repay },
  ],
};

/**
 * The tokens each job's spend covers, each with no limit. Protect lists aUSDC as well as USDC: with checker 0, a
 * withdrawal of savings moves no USDC from the account, and the manager meters only a token it watches
 * (contracts/docs/MANAGER-NOTES.md §1).
 */
const SPENT: Record<CashJob, readonly Address[]> = {
  save: [USDC.address],
  protect: [USDC.address, PROTOCOLS.AUSDC],
};

/** What the app sends to JAW's `useGrantPermissions` to switch `job` on: a spend a day with no limit. */
export function agentGrant(job: CashJob): PermissionsDetail {
  return {
    calls: CALLS[job].map(({ target, selector }) => ({ target, selector })),
    spends: SPENT[job].map((token) => ({ token, allowance: NO_LIMIT.toString(), unit: "day" })),
  };
}

/** The window and salt a grant is signed with: everything a template doesn't fix. */
type Signed = { account: Address; spender: Address; start: number; end: number; salt: bigint };

/**
 * The permission JAW's grant puts on-chain for `agentGrant(job)`: checker 0, Day × 1, and the start and salt the app
 * picks (core rpc/permissions.js apiPermissionsToPermission). GooseGuard stores exactly these bytes.
 */
export function agentPermission(job: CashJob, p: Signed): JawPermission {
  return {
    ...signed(p),
    calls: CALLS[job].map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: SPENT[job].map((token) => ({ token, allowance: NO_LIMIT, unit: PERIOD.Day, multiplier: 1 })),
  };
}

const signed = (p: Signed) => ({ account: p.account, spender: p.spender, start: p.start, end: p.end, salt: p.salt });

/*
 * Protect · sell (GooseGuard's job 2): when the cash can't bring the credit back to the target under Protect's line (or
 * during a rescue), the Guard sells some of the stock that backs it and repays. Its own JAW grant, so selling can be
 * switched off alone (decision 5); not one of the Cash Agent switches (`CASH_JOBS`).
 */

/**
 * The stocks a grant may sell, by reserve id (EQUITIES order): NO_LIMIT for a stock it may sell, 0 for one it never
 * sells. There is no amount per stock (decision 9): the list only says which stocks.
 */
export type StockLimits = readonly bigint[];

/** The stocks a grant may sell, in reserve order. `job` names the agent in the error. */
function sellable(limitsRaw: StockLimits, job = "Protector") {
  if (limitsRaw.length !== EQUITIES.length) throw new Error("One entry per stock");
  if (limitsRaw.some((l) => l !== 0n && l !== NO_LIMIT)) throw new Error("A stock is sold with no limit, or never");
  const stocks = EQUITIES.filter((_, i) => limitsRaw[i] > 0n);
  if (stocks.length === 0) throw new Error(`${job} needs at least one stock it may sell`);
  return stocks.map((e) => e.address);
}

/**
 * What the sell permission may call: take a stock out of Aave, approve each sellable stock to Aerodrome's router, swap,
 * approve USDC, repay, and apply Aave's latest settings to the account (`updateUserDynamicConfig`, GooseGuard's REFRESH:
 * only the account or a manager it approved may, step0-facts.md fact 5). A never-sell stock has no approve, so JAW's
 * manager refuses any batch that would sell it.
 */
function sellCalls(limitsRaw: StockLimits) {
  return [
    { target: AAVE.SPOKE, selector: SEL.spokeWithdraw },
    ...sellable(limitsRaw).map((stock) => ({ target: stock, selector: SEL.approve })),
    { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
    { target: USDC.address, selector: SEL.approve },
    { target: AAVE.SPOKE, selector: SEL.repay },
    { target: AAVE.SPOKE, selector: SEL.spokeRefresh },
  ] as const;
}

/**
 * Its spends, a day each and no limit: USDC on the repay leg and aUSDC (nothing here moves savings, so the manager
 * watches any savings move a batch could make), then each sellable stock.
 */
function sellSpends(limitsRaw: StockLimits) {
  return [USDC.address, PROTOCOLS.AUSDC, ...sellable(limitsRaw)];
}

/** What the app sends to JAW's `useGrantPermissions` to switch Protect · sell on. */
export function sellGrant(limitsRaw: StockLimits): PermissionsDetail {
  return {
    calls: sellCalls(limitsRaw).map(({ target, selector }) => ({ target, selector })),
    spends: sellSpends(limitsRaw).map((token) => ({ token, allowance: NO_LIMIT.toString(), unit: "day" })),
  };
}

/** The permission JAW's grant puts on-chain for `sellGrant(limitsRaw)`; GooseGuard stores exactly these bytes. */
export function sellPermission(p: Signed & { limitsRaw: StockLimits }): JawPermission {
  return {
    ...signed(p),
    calls: sellCalls(p.limitsRaw).map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: sellSpends(p.limitsRaw).map((token) => ({ token, allowance: NO_LIMIT, unit: PERIOD.Day, multiplier: 1 })),
  };
}

/*
 * The Rebalancer (GooseGuard's job 3): keeps the mix of free stock on target, selling what grew too big to buy what
 * fell short, and with top-ups on puts the wallet's top-ups into the mix. Its own JAW grant. It has no Aave call at
 * all, so savings and the stock that backs credit are out of its reach (decision 1: savings never go into stock).
 */

/**
 * What the Rebalancer may call: approve each stock it may sell to Aerodrome's router, approve USDC for the buys, swap.
 * A stock it may not sell can still be bought into the mix, but never sold.
 */
function rebalanceCalls(limitsRaw: StockLimits) {
  return [
    ...sellable(limitsRaw, "Rebalancer").map((stock) => ({ target: stock, selector: SEL.approve })),
    { target: USDC.address, selector: SEL.approve },
    { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
  ];
}

/**
 * The spends, a week each with no limit: USDC on the buy leg, then each stock it may sell (the manager refuses an
 * approve of a token with no spend, `NoSpendPermissions`).
 */
function rebalanceSpends(limitsRaw: StockLimits) {
  return [USDC.address, ...sellable(limitsRaw, "Rebalancer")];
}

/** What the app sends to JAW's `useGrantPermissions` to switch the Rebalancer on, with the stocks it may sell. */
export function rebalanceGrant(limitsRaw: StockLimits): PermissionsDetail {
  return {
    calls: rebalanceCalls(limitsRaw).map(({ target, selector }) => ({ target, selector })),
    spends: rebalanceSpends(limitsRaw).map((token) => ({ token, allowance: NO_LIMIT.toString(), unit: "week" })),
  };
}

/** The permission JAW's grant puts on-chain for `rebalanceGrant(limitsRaw)`; GooseGuard stores exactly these bytes. */
export function rebalancePermission(p: Signed & { limitsRaw: StockLimits }): JawPermission {
  return {
    ...signed(p),
    calls: rebalanceCalls(p.limitsRaw).map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: rebalanceSpends(p.limitsRaw).map((token) => ({
      token,
      allowance: NO_LIMIT,
      unit: PERIOD.Week,
      multiplier: 1,
    })),
  };
}

/*
 * Turn into cash on its own (GooseGuard's job 4, CONVERT): a coin of CASH_COINS in the wallet becomes USDC in the same
 * wallet, at 99.5% of face value or better. Its own JAW grant.
 */

/** The three venues' swaps, as GooseGuard calls them for each coin's venue in lib/tokens/stables.ts. */
const ENTRY_SWAPS = [
  { target: AERODROME_V1.ROUTER, selector: SEL.aeroSwap },
  { target: UNISWAP.SWAP_ROUTER_02, selector: SEL.uniSwap },
  { target: SPARK_PSM3.PSM3, selector: SEL.psmSwap },
] as const;

/**
 * What Entry may call: approve each coin of CASH_COINS (in its order, GooseGuard's `k`) to its venue, then the three
 * venues' swaps. Its spends: one a day per coin, with no limit.
 */
function entryCalls() {
  return [...CASH_COINS.map((c) => ({ target: c.address, selector: SEL.approve })), ...ENTRY_SWAPS];
}

/** What the app sends to JAW's `useGrantPermissions` to switch Entry on. */
export function entryGrant(): PermissionsDetail {
  return {
    calls: entryCalls().map(({ target, selector }) => ({ target, selector })),
    spends: CASH_COINS.map((c) => ({ token: c.address, allowance: NO_LIMIT.toString(), unit: "day" })),
  };
}

/** The permission JAW's grant puts on-chain for `entryGrant()`; GooseGuard stores exactly these bytes. */
export function entryPermission(p: Signed): JawPermission {
  return {
    ...signed(p),
    calls: entryCalls().map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: CASH_COINS.map((c) => ({ token: c.address, allowance: NO_LIMIT, unit: PERIOD.Day, multiplier: 1 })),
  };
}

/*
 * Every job, as JAW's screen grants it and lists it.
 */

/** What the app sends to JAW's `useGrantPermissions` to switch `job` on: for a StockJob, the stocks it may sell. */
export function jobGrant(job: AgentJob, limitsRaw?: StockLimits): PermissionsDetail {
  if (job === "save" || job === "protect") return agentGrant(job);
  if (job === "entry") return entryGrant();
  if (!limitsRaw) throw new Error("One entry per stock");
  return job === "sell" ? sellGrant(limitsRaw) : rebalanceGrant(limitsRaw);
}

/**
 * The permission JAW put on-chain for a grant of ours (`readAgentGrant`): the job's builder with the start, end and salt
 * it was signed with, exactly the bytes GooseGuard's `register` stores.
 */
export function grantPermission(g: AgentGrant, account: Address, spender: Address): JawPermission {
  const s = { account, spender, start: g.start, end: g.end, salt: g.salt };
  if (g.job === "save" || g.job === "protect") return agentPermission(g.job, s);
  if (g.job === "entry") return entryPermission(s);
  if (!g.limitsRaw) throw new Error("One entry per stock");
  return g.job === "sell"
    ? sellPermission({ ...s, limitsRaw: g.limitsRaw })
    : rebalancePermission({ ...s, limitsRaw: g.limitsRaw });
}

/**
 * The stocks a Protect · sell or Rebalancer grant may sell, by reserve id: NO_LIMIT for each stock in `sellable`,
 * 0 for the rest (the grant has no approve for it).
 */
export function stockLimitsRaw(sellable: readonly boolean[]): StockLimits {
  return EQUITIES.map((e) => (sellable[e.reserveId] ? NO_LIMIT : 0n));
}

/** A permission as JAW's `usePermissions` lists it (the relay's record). */
export type ListedPermission = {
  permissionId: string;
  spender: string;
  start: number;
  end: number;
  salt: string;
  calls: { target: string; selector: string; checker?: string }[];
  spends: { token: string; allowance: string; unit: string; multiplier: number }[];
};

/**
 * JAW's grant response (`useGrantPermissions`), read as its list records the grant, so `readAgentGrant` reads both
 * alike. A call's selector is the one field the response may leave out; none of ours does.
 */
export function listedFromGrant(r: {
  permissionId: string;
  spender: string;
  start: number;
  end: number;
  salt: string;
  calls: readonly { target: string; selector?: string }[];
  spends: readonly { token: string; allowance: string; unit: string; multiplier?: number }[];
}): ListedPermission {
  return {
    permissionId: r.permissionId,
    spender: r.spender,
    start: r.start,
    end: r.end,
    salt: r.salt,
    calls: r.calls.map((c) => ({ target: c.target, selector: c.selector ?? "0x" })),
    spends: r.spends.map((x) => ({
      token: x.token,
      allowance: x.allowance,
      unit: x.unit,
      multiplier: x.multiplier ?? 1,
    })),
  };
}

export type AgentGrant = {
  job: AgentJob;
  permissionId: Hex;
  start: number;
  end: number;
  salt: bigint;
  /** Protect · sell and the Rebalancer: the stocks it may sell, by reserve id (NO_LIMIT), and those it may not (0). */
  limitsRaw?: StockLimits;
};

/** Where a job's stocks start among its spends: after USDC and aUSDC (Protect · sell), after USDC (the Rebalancer). */
const firstStockSpend = (job: StockJob) => (job === "sell" ? 2 : 1);

/** The stocks a `job` grant's spends name, by reserve id, each at the allowance it lists; null if one isn't a stock. */
export function readStockLimits(
  job: StockJob,
  spends: readonly { token: string; allowance: string | bigint }[],
): StockLimits | null {
  const limits: bigint[] = EQUITIES.map(() => 0n);
  for (const s of spends.slice(firstStockSpend(job))) {
    const stock = EQUITIES.find((e) => isAddressEqual(e.address, s.token as Address));
    if (!stock) return null;
    limits[stock.reserveId] = BigInt(s.allowance);
  }
  return limits;
}

/** True when a listed permission is exactly `want`, as JAW's screen grants it: checker 0 and × 1 everywhere. */
function isTemplate(p: ListedPermission, want: PermissionsDetail): boolean {
  const calls = want.calls ?? [];
  const spends = want.spends ?? [];
  return (
    p.calls.length === calls.length &&
    calls.every(
      (c, i) =>
        isAddressEqual(p.calls[i].target as Address, c.target) &&
        p.calls[i].selector.toLowerCase() === c.selector?.toLowerCase() &&
        (!p.calls[i].checker || isAddressEqual(p.calls[i].checker as Address, zeroAddress)),
    ) &&
    p.spends.length === spends.length &&
    spends.every(
      (s, i) =>
        isAddressEqual(p.spends[i].token as Address, s.token) &&
        p.spends[i].unit === s.unit &&
        p.spends[i].multiplier === 1 &&
        BigInt(p.spends[i].allowance) === BigInt(s.allowance),
    )
  );
}

/**
 * Reads a listed permission as one of ours: GooseGuard as spender and exactly one job's template, every allowance at
 * NO_LIMIT, rebuilt from the stocks it lists (`jobGrant`), so a grant JAW stored for anything else never counts as an
 * agent. The allowlist reads every grant a batch approves, registers or revokes through this (lib/agents/agentJob.ts).
 */
export function readAgentGrant(p: ListedPermission, guard: Address): AgentGrant | null {
  if (!isAddressEqual(p.spender as Address, guard) || p.spends.length === 0) return null;
  for (const job of JOBS) {
    const limitsRaw = job === "sell" || job === "rebalance" ? readStockLimits(job, p.spends) : undefined;
    if (limitsRaw === null) continue;
    let want: PermissionsDetail;
    try {
      want = jobGrant(job, limitsRaw);
    } catch {
      continue; // not this job's shape (a stock with a limit, no stock to sell)
    }
    if (!isTemplate(p, want)) continue;
    return {
      job,
      permissionId: p.permissionId as Hex,
      start: p.start,
      end: p.end,
      salt: BigInt(p.salt),
      ...(limitsRaw && { limitsRaw }),
    };
  }
  return null;
}

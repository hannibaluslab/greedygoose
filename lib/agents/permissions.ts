import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import type { PermissionsDetail } from "@jaw.id/wagmi";
import { AAVE } from "@/lib/aave/addresses";
import { GUARDIAN, SEL } from "@/lib/guardian/config";
import { PERIOD, type GuardianPermission } from "@/lib/guardian/permission";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/** The agents' jobs, in GooseExecutor's order (enum Job): the index is the job's id on-chain. */
export const JOBS = ["save", "protect", "sell", "rebalance", "entry"] as const;
export type AgentJob = (typeof JOBS)[number];
/** The Cash Agent's two jobs (the Agents switches): one daily USDC limit each. */
export const CASH_JOBS = ["save", "protect"] as const;
export type CashJob = (typeof CASH_JOBS)[number];

/**
 * What each job may call, in the order of GooseExecutor's templates (`_permission`). JAW's screen grants every call
 * with checker 0 (D14), so the manager pins no argument: the executor builds each call for the account alone and
 * its post-checks revert anything else.
 */
const CALLS: Record<CashJob, readonly { target: Address; selector: Hex }[]> = {
  save: [
    { target: USDC.address, selector: SEL.approve },
    { target: GUARDIAN.AAVE_V3_POOL, selector: SEL.supply },
  ],
  protect: [
    { target: GUARDIAN.AAVE_V3_POOL, selector: SEL.withdraw },
    { target: USDC.address, selector: SEL.approve },
    { target: AAVE.SPOKE, selector: SEL.repay },
  ],
};

/**
 * The tokens each job's daily limit covers, all at the same cap. Protect needs aUSDC as well as USDC: with checker 0,
 * a withdrawal of savings to someone else moves no USDC from the account, so a USDC limit alone would charge it
 * nothing (contracts/docs/MANAGER-NOTES.md §1).
 */
const LIMITED: Record<CashJob, readonly Address[]> = {
  save: [USDC.address],
  protect: [USDC.address, GUARDIAN.AUSDC],
};

/**
 * The daily limit each job is switched on with: Protection's is the boards' "up to $300 a day" (HomeCreditSlide,
 * Agents). Save only moves the account's own USDC into its own savings, so its limit is wider. Both wait on the
 * calibration pass (plan item 6 step 9).
 */
export const DAILY_LIMIT_USD: Record<CashJob, number> = { save: 1_000, protect: 300 };

/**
 * What the agent list says each agent may sell until its own grant says otherwise: the Agents board's "sells up to
 * $300 a day" for Protect · sell (the same as Protect's, decision 5) and "sells up to $500 a week" for the Rebalancer.
 */
export const SELL_LIMIT_USD = { sell: { usd: 300, per: "day" }, rebalance: { usd: 500, per: "week" } } as const;

/** A job's daily limit in USDC units, never above the executor's `CAP_MAX` (a D13 test deploy allows $5). */
export function dailyLimitRaw(job: CashJob, capMaxRaw: bigint): bigint {
  const raw = BigInt(DAILY_LIMIT_USD[job]) * 10n ** BigInt(USDC.decimals);
  return raw < capMaxRaw ? raw : capMaxRaw;
}

/** What the app sends to JAW's `useGrantPermissions` to switch `job` on, with a daily limit in USDC units. */
export function agentGrant(job: CashJob, capRaw: bigint): PermissionsDetail {
  if (capRaw <= 0n) throw new Error("Daily limit must be positive");
  return {
    calls: CALLS[job].map(({ target, selector }) => ({ target, selector })),
    spends: LIMITED[job].map((token) => ({ token, allowance: capRaw.toString(), unit: "day" })),
  };
}

/**
 * The permission JAW's grant puts on-chain for `agentGrant(job, capRaw)`: checker 0, Day × 1, and the start and salt
 * JAW's SDK picks (core rpc/permissions.js apiPermissionsToPermission). GooseExecutor rebuilds the same struct.
 */
export function agentPermission(
  job: CashJob,
  p: { account: Address; spender: Address; start: number; end: number; salt: bigint; capRaw: bigint },
): GuardianPermission {
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: CALLS[job].map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: LIMITED[job].map((token) => ({ token, allowance: p.capRaw, unit: PERIOD.Day, multiplier: 1 })),
  };
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

/** One of ours in JAW's list. `capRaw` is the first limit, the one the executor stores: USDC units, a week's for the Rebalancer. */
export type AgentGrant = { job: AgentJob; permissionId: Hex; capRaw: bigint; start: number; end: number; salt: bigint };

/** A listing's limit per stock, by reserve id, from its spends after the first `skip` (USDC's, and aUSDC's for a sale). */
function listedStockLimits(p: ListedPermission, skip: number): StockLimits {
  const spends = p.spends.slice(skip);
  return EQUITIES.map((e) => BigInt(spends.find((s) => isAddressEqual(s.token as Address, e.address))?.allowance ?? 0));
}

/** What the app sends to switch `job` on with the listing's own limits; null when no grant of that job carries them. */
function templateFor(job: AgentJob, p: ListedPermission, capRaw: bigint): PermissionsDetail | null {
  try {
    if (job === "sell") return sellGrant(capRaw, listedStockLimits(p, 2));
    if (job === "rebalance") return rebalanceGrant(capRaw, listedStockLimits(p, 1));
    if (job === "entry") return entryGrant(capRaw);
    return agentGrant(job, capRaw);
  } catch {
    return null;
  }
}

/** The listing is exactly the template: every call with checker 0 and every limit × 1, in order. */
function isTemplate(p: ListedPermission, t: PermissionsDetail): boolean {
  const calls = t.calls ?? [];
  const spends = t.spends ?? [];
  return (
    p.calls.length === calls.length &&
    calls.every(
      (c, i) =>
        isAddressEqual(p.calls[i].target as Address, c.target) &&
        p.calls[i].selector.toLowerCase() === c.selector &&
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

/** Reads a listed permission as one of ours: the executor as spender and exactly one job's template. */
export function readAgentGrant(p: ListedPermission, executor: Address): AgentGrant | null {
  if (!isAddressEqual(p.spender as Address, executor) || p.spends.length === 0) return null;
  const capRaw = BigInt(p.spends[0].allowance);
  if (capRaw <= 0n) return null;
  const job = JOBS.find((j) => {
    const t = templateFor(j, p, capRaw);
    return t !== null && isTemplate(p, t);
  });
  return job ? { job, permissionId: p.permissionId as Hex, capRaw, start: p.start, end: p.end, salt: BigInt(p.salt) } : null;
}

/*
 * Protect · sell (GooseExecutor's Job.ProtectSell, id 2): when savings can't keep the credit Safe, the executor sells
 * some of the stock that backs it and repays. Its own JAW grant, so selling can be switched off alone (decision 5);
 * not one of the Cash Agent switches (`CASH_JOBS`).
 */

/** A stock's daily limit is a whole number of these raw units (1e-4 share): the executor packs all seven in one word. */
export const STOCK_LIMIT_UNIT = 10_000n;

/** A daily limit per stock, in raw shares, by reserve id (EQUITIES order). 0 = never sell that stock. */
export type StockLimits = readonly bigint[];

/** The stocks a grant may sell, each with its limit, in reserve order. `job` names the agent in the error. */
function sellable(limitsRaw: StockLimits, job = "Protect") {
  if (limitsRaw.length !== EQUITIES.length) throw new Error("One limit per stock");
  if (limitsRaw.some((l) => l < 0n || l % STOCK_LIMIT_UNIT !== 0n || l / STOCK_LIMIT_UNIT >= 2n ** 32n)) {
    throw new Error("Stock limits are whole units of 1e-4 share");
  }
  const stocks = EQUITIES.filter((_, i) => limitsRaw[i] > 0n);
  if (stocks.length === 0) throw new Error(`${job} needs at least one stock it may sell`);
  return stocks.map((e) => ({ stock: e.address, limitRaw: limitsRaw[e.reserveId] }));
}

/**
 * What the sell permission may call, in GooseExecutor's order (SellJob.permission): take a stock out of Aave, approve
 * each sellable stock to Aerodrome's router, swap, approve USDC, repay. A never-sell stock has no approve, so JAW's
 * manager refuses any batch that would sell it.
 */
function sellCalls(limitsRaw: StockLimits) {
  return [
    { target: AAVE.SPOKE, selector: SEL.spokeWithdraw },
    ...sellable(limitsRaw).map(({ stock }) => ({ target: stock, selector: SEL.approve })),
    { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
    { target: USDC.address, selector: SEL.approve },
    { target: AAVE.SPOKE, selector: SEL.repay },
  ] as const;
}

/**
 * Daily limits: USDC on the repay leg and aUSDC at the same cap (nothing here moves savings, so the manager bounds any
 * savings move a batch could make through an allowance the account gave elsewhere), then each sellable stock's own.
 */
function sellSpends(capRaw: bigint, limitsRaw: StockLimits) {
  return [
    { token: USDC.address, allowance: capRaw },
    { token: GUARDIAN.AUSDC, allowance: capRaw },
    ...sellable(limitsRaw).map(({ stock, limitRaw }) => ({ token: stock, allowance: limitRaw })),
  ];
}

/** What the app sends to JAW's `useGrantPermissions` to switch Protect · sell on. */
export function sellGrant(capRaw: bigint, limitsRaw: StockLimits): PermissionsDetail {
  if (capRaw <= 0n) throw new Error("Daily limit must be positive");
  return {
    calls: sellCalls(limitsRaw).map(({ target, selector }) => ({ target, selector })),
    spends: sellSpends(capRaw, limitsRaw).map(({ token, allowance }) => ({ token, allowance: allowance.toString(), unit: "day" })),
  };
}

/** The permission JAW's grant puts on-chain for `sellGrant(capRaw, limitsRaw)`; GooseExecutor rebuilds the same struct. */
export function sellPermission(p: {
  account: Address;
  spender: Address;
  start: number;
  end: number;
  salt: bigint;
  capRaw: bigint;
  limitsRaw: StockLimits;
}): GuardianPermission {
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: sellCalls(p.limitsRaw).map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: sellSpends(p.capRaw, p.limitsRaw).map(({ token, allowance }) => ({ token, allowance, unit: PERIOD.Day, multiplier: 1 })),
  };
}

/**
 * The `terms` the executor's `register` takes for Protect · sell and the Rebalancer: each stock's limit in units,
 * 32 bits a stock.
 */
export function stockTerms(limitsRaw: StockLimits): bigint {
  sellable(limitsRaw);
  return limitsRaw.reduce((t, l, r) => t | ((l / STOCK_LIMIT_UNIT) << BigInt(32 * r)), 0n);
}

/*
 * The Rebalancer (GooseExecutor's Job.Rebalance, id 3): keeps the mix of free stock on target, selling what grew too
 * big to buy what fell short. Its own JAW grant. It has no Aave call at all, so savings and backing are out of its
 * reach; the executor's post-checks keep the wallet's USDC from going down and every stock it buys in the mix.
 */

/**
 * What the Rebalancer may call, in GooseExecutor's order (RebalanceJob.permission): approve each stock it may sell to
 * Aerodrome's router, approve USDC for the buys, swap. A stock with no limit can still be bought into the mix, but
 * never sold.
 */
function rebalanceCalls(limitsRaw: StockLimits) {
  return [
    ...sellable(limitsRaw, "The Rebalancer").map(({ stock }) => ({ target: stock, selector: SEL.approve })),
    { target: USDC.address, selector: SEL.approve },
    { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
  ] as const;
}

/** Weekly limits: USDC on the buy leg (the boards' "sells up to $X a week"), then each stock's own, in shares. */
function rebalanceSpends(capRaw: bigint, limitsRaw: StockLimits) {
  return [
    { token: USDC.address, allowance: capRaw },
    ...sellable(limitsRaw, "The Rebalancer").map(({ stock, limitRaw }) => ({ token: stock, allowance: limitRaw })),
  ];
}

/** What the app sends to JAW's `useGrantPermissions` to switch the Rebalancer on, with weekly limits. */
export function rebalanceGrant(capRaw: bigint, limitsRaw: StockLimits): PermissionsDetail {
  if (capRaw <= 0n) throw new Error("Weekly limit must be positive");
  return {
    calls: rebalanceCalls(limitsRaw).map(({ target, selector }) => ({ target, selector })),
    spends: rebalanceSpends(capRaw, limitsRaw).map(({ token, allowance }) => ({ token, allowance: allowance.toString(), unit: "week" })),
  };
}

/** The permission JAW's grant puts on-chain for `rebalanceGrant(capRaw, limitsRaw)`; GooseExecutor rebuilds it. */
export function rebalancePermission(p: {
  account: Address;
  spender: Address;
  start: number;
  end: number;
  salt: bigint;
  capRaw: bigint;
  limitsRaw: StockLimits;
}): GuardianPermission {
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: rebalanceCalls(p.limitsRaw).map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: rebalanceSpends(p.capRaw, p.limitsRaw).map(({ token, allowance }) => ({ token, allowance, unit: PERIOD.Week, multiplier: 1 })),
  };
}

/*
 * The Entry agent on Base (GooseExecutor's Job.Entry, id 4): a whitelisted stablecoin in the wallet becomes USDC in the
 * same wallet, at 99.5% of face value or better. Its own JAW grant.
 */

/** Each coin's swap, at the venue lib/tokens/stables.ts names for it. */
const ENTRY_SWAPS = [
  { target: AERODROME_V1.ROUTER, selector: SEL.aeroSwap },
  { target: UNISWAP.SWAP_ROUTER_02, selector: SEL.uniSwap },
  { target: SPARK_PSM3.PSM3, selector: SEL.psmSwap },
] as const;

/**
 * What Entry may call, in GooseExecutor's order (EntryJob.permission): approve each coin to its venue, then the three
 * venues' swaps. Daily limits: one per coin, all at the same face value (`capRaw` in USDC units, decimals adjusted).
 */
function entryCalls() {
  return [...ENTRY_COINS.map((c) => ({ target: c.address, selector: SEL.approve })), ...ENTRY_SWAPS];
}

function entrySpends(capRaw: bigint) {
  return ENTRY_COINS.map((c) => ({ token: c.address, allowance: capRaw * 10n ** BigInt(c.decimals - USDC.decimals) }));
}

/** What the app sends to JAW's `useGrantPermissions` to switch Entry on, with a daily limit per coin in USDC units. */
export function entryGrant(capRaw: bigint): PermissionsDetail {
  if (capRaw <= 0n) throw new Error("Daily limit must be positive");
  return {
    calls: entryCalls().map(({ target, selector }) => ({ target, selector })),
    spends: entrySpends(capRaw).map(({ token, allowance }) => ({ token, allowance: allowance.toString(), unit: "day" })),
  };
}

/** The permission JAW's grant puts on-chain for `entryGrant(capRaw)`; GooseExecutor rebuilds the same struct. */
export function entryPermission(p: {
  account: Address;
  spender: Address;
  start: number;
  end: number;
  salt: bigint;
  capRaw: bigint;
}): GuardianPermission {
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: entryCalls().map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: entrySpends(p.capRaw).map(({ token, allowance }) => ({ token, allowance, unit: PERIOD.Day, multiplier: 1 })),
  };
}

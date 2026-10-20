import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import type { PermissionsDetail } from "@jaw.id/wagmi";
import { AAVE } from "@/lib/aave/addresses";
import { PROTOCOLS, SEL } from "@/lib/protocols/config";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/** PeriodUnit enum in JustaPermissionManager (JustaPermissionManager.sol:206-213). There is no Year. */
export const PERIOD = { Minute: 0, Hour: 1, Day: 2, Week: 3, Month: 4, Forever: 5 } as const;

export type JawPermission = {
  account: `0x${string}`;
  spender: `0x${string}`;
  start: number;
  end: number;
  salt: bigint;
  calls: { target: `0x${string}`; selector: Hex; checker: `0x${string}` }[];
  spends: { token: `0x${string}`; allowance: bigint; unit: number; multiplier: number }[];
};

/** The agents' jobs, in GooseExecutor's order (enum Job): the index is the job's id on-chain. */
export const JOBS = ["save", "protect", "sell", "rebalance", "entry"] as const;
export type AgentJob = (typeof JOBS)[number];
/** The Cash Agent's two jobs (the Agents switches): one daily USDC limit each. */
export const CASH_JOBS = ["save", "protect"] as const;
type CashJob = (typeof CASH_JOBS)[number];
/** The jobs whose grant carries a limit per stock: Protect · sell (a day) and the Rebalancer (a week). */
type StockJob = "sell" | "rebalance";

/**
 * What each job may call, in the order of GooseExecutor's templates (`_permission`). JAW's screen grants every call
 * with checker 0 (D14), so the manager pins no argument: the executor builds each call for the account alone and
 * its post-checks revert anything else.
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
 * The tokens each job's daily limit covers, all at the same cap. Protect needs aUSDC as well as USDC: with checker 0,
 * a withdrawal of savings to someone else moves no USDC from the account, so a USDC limit alone would charge it
 * nothing (contracts/docs/MANAGER-NOTES.md §1). Protect's cap is the executor's CAP_MAX (`NO_LIMIT_JOBS`).
 */
const LIMITED: Record<CashJob, readonly Address[]> = {
  save: [USDC.address],
  protect: [USDC.address, PROTOCOLS.AUSDC],
};

/**
 * The jobs with no amount limit: Protect's two and the Rebalancer. Like DeFi Saver, each is limited by what it does,
 * not by how much. Protect acts below 1.03, goes back to 1.12, and no move lands past the target; the Rebalancer trades
 * only a stock past its band, partway back, once a market day. Their grants carry the executor's CAP_MAX, the most a
 * grant may hold (a D13 test deploy allows $5), and the user types no limit.
 */
export const NO_LIMIT_JOBS = ["protect", "sell", "rebalance"] as const;
type LimitedJob = Exclude<AgentJob, (typeof NO_LIMIT_JOBS)[number]>;
export const hasLimit = (job: AgentJob): job is LimitedJob => !(NO_LIMIT_JOBS as readonly AgentJob[]).includes(job);

/**
 * The limit each other job is switched on with, in dollars a day. Save and Entry run under the hood (D20), each at
 * $1,000 a day with no other offer. Both wait on the calibration pass (plan item 6 step 9).
 */
export const LIMIT_USD: Record<LimitedJob, { start: number }> = {
  save: { start: 1_000 },
  entry: { start: 1_000 },
};

/** A dollar limit in USDC units, never above the executor's `CAP_MAX` (a D13 test deploy allows $5). */
export function limitRaw(usd: number, capMaxRaw: bigint): bigint {
  const raw = BigInt(usd) * 10n ** BigInt(USDC.decimals);
  return raw < capMaxRaw ? raw : capMaxRaw;
}

/** The cap a job is switched on with: CAP_MAX for a job with no amount limit, its starting limit otherwise. */
export function startCapRaw(job: AgentJob, capMaxRaw: bigint): bigint {
  return hasLimit(job) ? limitRaw(LIMIT_USD[job].start, capMaxRaw) : capMaxRaw;
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
): JawPermission {
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

/*
 * Protect · sell (GooseExecutor's Job.ProtectSell, id 2): when savings can't bring the credit back to 1.12 below
 * Protect's line (or during a rescue), the executor sells some of the stock that backs it and repays. Its own JAW grant,
 * so selling can be switched off alone (decision 5); not one of the Cash Agent switches (`CASH_JOBS`).
 */

/** A stock's daily limit is a whole number of these raw units (1e-4 share): the executor packs all seven in one word. */
export const STOCK_LIMIT_UNIT = 10_000n;
/** The most a stock's limit can be: 32 bits of units, what the grant's terms hold (`stockTerms`). */
const STOCK_LIMIT_MAX = (2n ** 32n - 1n) * STOCK_LIMIT_UNIT;

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
 * The cap is the executor's CAP_MAX: selling has no amount limit either (`NO_LIMIT_JOBS`).
 */
function sellSpends(capRaw: bigint, limitsRaw: StockLimits) {
  return [
    { token: USDC.address, allowance: capRaw },
    { token: PROTOCOLS.AUSDC, allowance: capRaw },
    ...sellable(limitsRaw).map(({ stock, limitRaw }) => ({ token: stock, allowance: limitRaw })),
  ];
}

/** What the app sends to JAW's `useGrantPermissions` to switch Protect · sell on. */
export function sellGrant(capRaw: bigint, limitsRaw: StockLimits): PermissionsDetail {
  if (capRaw <= 0n) throw new Error("Daily limit must be positive");
  return {
    calls: sellCalls(limitsRaw).map(({ target, selector }) => ({ target, selector })),
    spends: sellSpends(capRaw, limitsRaw).map(({ token, allowance }) => ({
      token,
      allowance: allowance.toString(),
      unit: "day",
    })),
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
}): JawPermission {
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: sellCalls(p.limitsRaw).map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: sellSpends(p.capRaw, p.limitsRaw).map(({ token, allowance }) => ({
      token,
      allowance,
      unit: PERIOD.Day,
      multiplier: 1,
    })),
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
 * big to buy what fell short. Its own JAW grant. Without top-ups it has no Aave call at all, so savings and backing are
 * out of its reach. With top-ups (`topUps`), it may also take savings out to the account, under an aUSDC limit, to put
 * top-ups into the mix; backing stays out of reach. The executor's post-checks keep the wallet's USDC from going down,
 * savings from falling by more than what goes into the mix, and every stock it buys in the mix.
 */

/**
 * What the Rebalancer may call, in GooseExecutor's order (RebalanceJob.permission): with top-ups, Aave V3's savings
 * withdraw first; approve each stock it may sell to Aerodrome's router, approve USDC for the buys, swap. A stock with
 * no limit can still be bought into the mix, but never sold.
 */
function rebalanceCalls(limitsRaw: StockLimits, topUps: boolean) {
  return [
    ...(topUps ? [{ target: PROTOCOLS.AAVE_V3_POOL, selector: SEL.withdraw }] : []),
    ...sellable(limitsRaw, "The Rebalancer").map(({ stock }) => ({ target: stock, selector: SEL.approve })),
    { target: USDC.address, selector: SEL.approve },
    { target: AERODROME.ROUTER, selector: SEL.aeroSwap },
  ];
}

/**
 * The spends, a week each (`PeriodUnit.Week`, which keeps the template's hash): USDC on the buy leg at the executor's
 * CAP_MAX (no amount limit, `NO_LIMIT_JOBS`), with top-ups aUSDC at the same cap (the manager meters a savings
 * withdraw only through it), then each stock's own, in shares.
 */
function rebalanceSpends(capRaw: bigint, limitsRaw: StockLimits, topUps: boolean) {
  return [
    { token: USDC.address, allowance: capRaw },
    ...(topUps ? [{ token: PROTOCOLS.AUSDC, allowance: capRaw }] : []),
    ...sellable(limitsRaw, "The Rebalancer").map(({ stock, limitRaw }) => ({ token: stock, allowance: limitRaw })),
  ];
}

/**
 * What the app sends to JAW's `useGrantPermissions` to switch the Rebalancer on, with a limit per stock to sell, and
 * with `topUps` the savings withdraw that puts top-ups into the mix.
 */
export function rebalanceGrant(capRaw: bigint, limitsRaw: StockLimits, topUps = false): PermissionsDetail {
  if (capRaw <= 0n) throw new Error("USDC limit must be positive");
  return {
    calls: rebalanceCalls(limitsRaw, topUps).map(({ target, selector }) => ({ target, selector })),
    spends: rebalanceSpends(capRaw, limitsRaw, topUps).map(({ token, allowance }) => ({
      token,
      allowance: allowance.toString(),
      unit: "week",
    })),
  };
}

/**
 * The permission JAW's grant puts on-chain for `rebalanceGrant(capRaw, limitsRaw, topUps)`; GooseExecutor rebuilds it.
 */
export function rebalancePermission(p: {
  account: Address;
  spender: Address;
  start: number;
  end: number;
  salt: bigint;
  capRaw: bigint;
  limitsRaw: StockLimits;
  topUps?: boolean;
}): JawPermission {
  const topUps = p.topUps ?? false;
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: rebalanceCalls(p.limitsRaw, topUps).map(({ target, selector }) => ({
      target,
      selector,
      checker: zeroAddress,
    })),
    spends: rebalanceSpends(p.capRaw, p.limitsRaw, topUps).map(({ token, allowance }) => ({
      token,
      allowance,
      unit: PERIOD.Week,
      multiplier: 1,
    })),
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
    spends: entrySpends(capRaw).map(({ token, allowance }) => ({
      token,
      allowance: allowance.toString(),
      unit: "day",
    })),
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
}): JawPermission {
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: entryCalls().map(({ target, selector }) => ({ target, selector, checker: zeroAddress })),
    spends: entrySpends(p.capRaw).map(({ token, allowance }) => ({
      token,
      allowance,
      unit: PERIOD.Day,
      multiplier: 1,
    })),
  };
}

/*
 * Every job, as JAW's screen grants it and lists it.
 */

/** What the app sends to JAW's `useGrantPermissions` to switch `job` on: its limit, and one a stock for a StockJob. */
export function jobGrant(job: AgentJob, capRaw: bigint, limitsRaw?: StockLimits): PermissionsDetail {
  if (job === "save" || job === "protect") return agentGrant(job, capRaw);
  if (job === "entry") return entryGrant(capRaw);
  if (!limitsRaw) throw new Error("One limit per stock");
  return job === "sell" ? sellGrant(capRaw, limitsRaw) : rebalanceGrant(capRaw, limitsRaw);
}

/**
 * The permission JAW put on-chain for a grant of ours (`readAgentGrant`): the job's builder with the start, end and salt
 * JAW picked, exactly what GooseExecutor's `registerApproved` rebuilds and matches.
 */
export function grantPermission(g: AgentGrant, account: Address, spender: Address): JawPermission {
  const signed = { account, spender, start: g.start, end: g.end, salt: g.salt, capRaw: g.capRaw };
  if (g.job === "save" || g.job === "protect") return agentPermission(g.job, signed);
  if (g.job === "entry") return entryPermission(signed);
  if (!g.limitsRaw) throw new Error("One limit per stock");
  return g.job === "sell"
    ? sellPermission({ ...signed, limitsRaw: g.limitsRaw })
    : rebalancePermission({ ...signed, limitsRaw: g.limitsRaw });
}

/**
 * Each stock's limit in a Protect · sell or Rebalancer grant, from the dollar limit `capRaw`: shares worth twice it at
 * Aave's price now, so a stock that falls after the grant can still be sold up to the dollar limit (the USDC limit is
 * the one that binds). Held 1% under the executor's bound (twice CAP_MAX, JobBase.STOCK_LIMIT_CAPS), so a price tick
 * before registration doesn't refuse it, and never past what the grant's terms hold (32 bits of units a stock), which
 * binds for both jobs' CAP_MAX on a deploy with no amount limit. `pricesRaw` are Aave's prices by reserve id
 * (8 decimals); a stock `sellable` leaves out gets 0, so the grant has no approve for it.
 */
export function stockLimitsRaw(
  capRaw: bigint,
  capMaxRaw: bigint,
  pricesRaw: readonly bigint[],
  sellable: readonly boolean[],
): StockLimits {
  const bound = (2n * capMaxRaw * 99n) / 100n;
  const worth = 2n * capRaw < bound ? 2n * capRaw : bound;
  return EQUITIES.map((e) => {
    if (!sellable[e.reserveId] || pricesRaw[e.reserveId] <= 0n) return 0n;
    const shares = (worth * 10n ** 10n) / pricesRaw[e.reserveId];
    return shares < STOCK_LIMIT_MAX ? (shares / STOCK_LIMIT_UNIT) * STOCK_LIMIT_UNIT : STOCK_LIMIT_MAX;
  });
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
  capRaw: bigint;
  start: number;
  end: number;
  salt: bigint;
  /** Protect · sell and the Rebalancer: each stock's limit in raw shares, by reserve id; 0 = it may not sell it. */
  limitsRaw?: StockLimits;
};

/** Where a job's stock limits start among its spends: after USDC and aUSDC (Protect · sell), USDC (the Rebalancer). */
const FIRST_STOCK_SPEND: Record<StockJob, number> = { sell: 2, rebalance: 1 };

/** The stock limits a `job` grant's spends carry, by reserve id; null if one of them isn't a stock. */
export function readStockLimits(
  job: StockJob,
  spends: readonly { token: string; allowance: string | bigint }[],
): StockLimits | null {
  const limits: bigint[] = EQUITIES.map(() => 0n);
  for (const s of spends.slice(FIRST_STOCK_SPEND[job])) {
    const stock = EQUITIES.find((e) => isAddressEqual(e.address, s.token as Address));
    if (!stock) return null;
    limits[stock.reserveId] = BigInt(s.allowance);
  }
  return limits;
}

/** The limit and the stock limits a job's grant would carry, read off its spends; null if they can't be a job's. */
function readTerms(
  job: AgentJob,
  spends: ListedPermission["spends"],
): { capRaw: bigint; limitsRaw?: StockLimits } | null {
  const first = BigInt(spends[0].allowance);
  if (job === "save" || job === "protect") return { capRaw: first };
  if (job === "entry") return { capRaw: first / 10n ** BigInt(ENTRY_COINS[0].decimals - USDC.decimals) };
  const limitsRaw = readStockLimits(job, spends);
  return limitsRaw && { capRaw: first, limitsRaw };
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
 * Reads a listed permission as one of ours: the executor as spender and exactly one job's template, rebuilt from the
 * limits it lists (`jobGrant`), so a grant JAW stored for anything else never counts as an agent.
 */
export function readAgentGrant(p: ListedPermission, executor: Address): AgentGrant | null {
  if (!isAddressEqual(p.spender as Address, executor) || p.spends.length === 0) return null;
  for (const job of JOBS) {
    const terms = readTerms(job, p.spends);
    if (!terms || terms.capRaw <= 0n) continue;
    let want: PermissionsDetail;
    try {
      want = jobGrant(job, terms.capRaw, terms.limitsRaw);
    } catch {
      continue; // not this job's shape (a stock limit off the unit, no stock to sell)
    }
    if (!isTemplate(p, want)) continue;
    return {
      job,
      permissionId: p.permissionId as Hex,
      capRaw: terms.capRaw,
      start: p.start,
      end: p.end,
      salt: BigInt(p.salt),
      ...(terms.limitsRaw && { limitsRaw: terms.limitsRaw }),
    };
  }
  return null;
}

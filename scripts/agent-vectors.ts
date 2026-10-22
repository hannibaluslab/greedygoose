/**
 * Test vectors that tie GooseExecutor's Solidity to the TypeScript reference (docs/archive/goose-executor-plan.md §5,
 * §7, §11). Inputs come from keccak256(abi.encode(tag, i, field)) on both sides (contracts/test/Vectors.sol), so the
 * JSON only carries what TypeScript decided. Forge reads it with vm.parseJson.
 *
 *   npm run contracts:vectors   # rewrite contracts/test/vectors/*.json after changing a rule
 *
 * tests/unit/agents.test.ts fails while the committed files are stale.
 */
import { writeFileSync } from "node:fs";
import { encodeAbiParameters, hashTypedData, keccak256, parseUnits, toHex, type Address } from "viem";
import { CASH, CASH_AGENT, ENTRY, PROTECT_SELL, REBALANCER, RISK } from "@/config/risk";
import { PROTOCOLS } from "@/lib/protocols/config";
import { planEntry, type EntryCoin } from "@/lib/agents/rules/entry";
import { inWeekendWindow, planProtect, planSave } from "@/lib/agents/rules/protect";
import { planRebalance, rebalanceTrades, type RebalanceHolding } from "@/lib/agents/rules/rebalance";
import { planSell, sellAmounts, sellsNow, type SellBook } from "@/lib/agents/rules/protectSell";
import { investTrades, topUpCounted, topUpInvested, topUpsReady, type TopUpsState } from "@/lib/agents/rules/topUps";
import { marketState } from "@/lib/market-hours";
import {
  agentPermission,
  CASH_JOBS,
  entryPermission,
  NO_LIMIT,
  rebalancePermission,
  sellPermission,
  type StockLimits,
} from "@/lib/agents/permissions";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { encodePermission } from "@/lib/agents/register";

const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const VALUE_PER_USD = 10n ** 26n;
const DAY = 86_400n;

/** The same draw as Vectors.sol: uint256(keccak256(abi.encode(tag, i, field))). */
const rand = (tag: string, i: number, field: number) =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }, { type: "uint256" }],
        [tag, BigInt(i), BigInt(field)],
      ),
    ),
  );
const between = (r: bigint, lo: bigint, hi: bigint) => lo + (r % (hi - lo + 1n));
/** A wide spread of magnitudes: (1 to 9) × 10^(lo to hi). */
const spread = (r1: bigint, r2: bigint, lo: bigint, hi: bigint) => (1n + (r1 % 9n)) * 10n ** between(r2, lo, hi);
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const toFloat = (v: bigint, unit: bigint) => Number(v) / Number(unit);
const hex = (bytes: number[]) => toHex(Uint8Array.from(bytes));

/** ProtectCase in CashRules.sol. */
const PROTECT_CASE = { "no-debt": 0, healthy: 1, "no-savings": 2, "no-cap": 3, "too-small": 4, act: 5 } as const;
/** SaveCase in CashRules.sol. */
const SAVE_CASE = { "too-small": 0, "no-cap": 1, rate: 2, save: 3 } as const;

export const PROTECT_COUNT = 1000;
export const SAVE_COUNT = 1000;
export const CALENDAR_COUNT = 10_000;
export const HASH_COUNT = 50;
export const SELL_COUNT = 600;
export const TIMING_COUNT = 1000;
export const REBALANCE_COUNT = 800;
export const ENTRY_COUNT = 1000;
export const INVEST_COUNT = 600;
export const TOPUPS_COUNT = 1000;
/** Where Vectors.sol's hash test puts the executor, so both sides know the spender. */
export const HASH_SPENDER: Address = "0x0000000000000000000000000000000000600dE5";

/** Protect inputs, in on-chain units. Mirrors Vectors.protectInput: thresholds within the executor's bounds
 *  (2026-10-19), the trigger pinned to Protect's line (1.03) and the target from 1.08 to 1.40. Half the healths are
 *  under the line (0.80 to 1.03), the rest from the line through Watch into Safe (1.03 to 2.00), and half the accounts
 *  are in a rescue. */
export function protectInput(i: number) {
  const r = (f: number) => rand("protect", i, f);
  const triggerHf = (WAD * 103n) / 100n;
  const targetHf = between(r(15), triggerHf + WAD / 20n, (WAD * 14n) / 10n);
  const hf = r(14) % 2n === 0n ? between(r(4), (WAD * 8n) / 10n, triggerHf) : between(r(4), triggerHf, 2n * WAD);
  const rescuing = r(19) % 2n === 0n;

  const collateral = spread(r(0), r(1), 1n, 6n) * VALUE_PER_USD + (r(2) % VALUE_PER_USD);
  const avgCf = between(r(3), WAD / 2n, (WAD * 85n) / 100n);
  const debtValue = (((collateral * avgCf) / WAD) * WAD) / hf;
  const debtRay = r(6) % 20n === 0n ? 0n : debtValue * RAY + (r(5) % RAY);
  const savings = r(7) % 10n === 0n ? 0n : spread(r(8), r(9), 5n, 11n);
  const capLeft = r(10) % 10n === 0n ? 0n : spread(r(11), r(12), 5n, 10n);
  const minRepay = 50_000n * 10n ** (r(18) % 4n);
  return { collateral, avgCf, debtRay, savings, capLeft, triggerHf, targetHf, minRepay, rescuing };
}

/** Save inputs, in USDC units. Mirrors Vectors.saveInput. */
export function saveInput(i: number) {
  const r = (f: number) => rand("save", i, f);
  const keepBack = r(8) % 5_000_001n;
  const cash = r(0) % 5n === 0n ? r(1) % 10_000_000n : keepBack + spread(r(2), r(3), 5n, 10n);
  const capLeft = r(4) % 8n === 0n ? 0n : spread(r(5), r(6), 5n, 10n);
  const savesToday = r(7) % 12n;
  const minSave = 100_000n * 10n ** (r(9) % 4n);
  const maxSavesPerDay = 1n + (r(10) % 24n);
  return { cash, capLeft, savesToday, keepBack, minSave, maxSavesPerDay };
}

/** 2026-01-01T00:00:00Z, and five years from it. */
const CALENDAR_START = 1_767_225_600n;
const CALENDAR_RANGE = 1_826n * DAY;

/** A timestamp from 2026 to 2030. Odd ones land on a Friday between 15:00 and 03:00 UTC, around both edges of the
 *  Friday window, in summer and winter time. Mirrors Vectors.calendarTime. */
export function calendarTime(i: number): bigint {
  const r = (f: number) => rand("calendar", i, f);
  if (i % 2 === 0) return CALENDAR_START + (r(0) % CALENDAR_RANGE);
  const d = CALENDAR_START / DAY + (r(1) % (CALENDAR_RANGE / DAY));
  const friday = d - ((d + 6n) % 7n); // 1970-01-02 (day 1) was a Friday
  return friday * DAY + 15n * 3600n + (r(2) % (12n * 3600n));
}

/** Protect · sell inputs: a book and the options. Mirrors Vectors.sellInput. Holdings from 0.01 to 10,000 shares at
 *  $100–1,000, health from 0.95 to 1.3, a target from 1.08 to 1.4 (the executor's bounds, 2026-10-19), and limits,
 *  pool windows and the USDC limit that bind a fifth of the time. */
export function sellInput(i: number) {
  const r = (f: number) => rand("sell", i, f);
  const stocks = Array.from({ length: 7 }, (_, k) => {
    const f = (j: number) => r(10 + 12 * k + j);
    const sharesRaw = f(0) % 3n === 0n ? 0n : spread(f(1), f(2), 6n, 11n);
    const kind = f(5) % 4n;
    return {
      sharesRaw,
      price: between(f(3), 10n ** 10n, 10n ** 11n),
      cfBps: between(f(4), 5_000n, 8_500n),
      limitRaw: kind === 0n ? 0n : kind === 1n ? spread(f(6), f(7), 5n, 10n) : 10n ** 13n,
      poolLeftRaw: f(8) % 5n === 0n ? spread(f(9), f(10), 5n, 9n) : 10n ** 12n,
    };
  });
  const usdcPrice = between(r(0), 99_500_000n, 100_500_000n);
  const hf = between(r(1), (WAD * 95n) / 100n, (WAD * 13n) / 10n);
  const power = stocks.reduce((p, s) => p + s.cfBps * s.sharesRaw * s.price * 10n ** 10n, 0n);
  const book: SellBook = {
    stocks,
    debtValue: ceilDiv(power * 10n ** 14n, hf),
    usdcPrice,
    usdcLeftRaw: r(2) % 5n === 0n ? spread(r(3), r(4), 5n, 9n) : 10n ** 13n,
  };
  return {
    book,
    targetHf: between(r(5), (WAD * 108n) / 100n, (WAD * 14n) / 10n),
    floorBps: between(r(6), 25n, 500n),
    keepMix: r(7) % 3n === 0n,
    maxSliceRaw: between(r(8), 100n * 10n ** 6n, 50_000n * 10n ** 6n),
  };
}

/** Protect · sell timing inputs. Mirrors Vectors.timingInput: within the executor's bounds (2026-10-19), the line
 *  pinned at 1.03, the target from 1.08 to 1.20, the health from 0.98 to 1.20; half are in a rescue. */
export function timingInput(i: number) {
  const r = (f: number) => rand("timing", i, f);
  return {
    hf: between(r(1), (WAD * 98n) / 100n, (WAD * 120n) / 100n),
    rescuing: r(2) % 2n === 0n,
    frozen: r(4) % 4n === 0n,
    triggerHf: (WAD * 103n) / 100n,
    targetHf: between(r(5), (WAD * 108n) / 100n, (WAD * 120n) / 100n),
  };
}

/** Rebalancer inputs: a mix of one to seven stocks worth $1k to $900k drifted from its targets by up to 60%, free stock
 *  outside the mix a quarter of the time, weekly limits that bind a quarter of the time, a USDC limit that binds a
 *  fifth of the time, and a pool out of line a tenth of the time. Mirrors Vectors.rebalanceInput. */
export function rebalanceInput(i: number) {
  const r = (f: number) => rand("rebalance", i, f);
  const first = Number(r(0) % 7n);
  const raw = Array.from({ length: 7 }, (_, k) =>
    k === first || r(1 + k) % 3n !== 0n ? 1n + (r(10 + k) % 1000n) : 0n,
  );
  const sum = raw.reduce((a, b) => a + b, 0n);
  const weights = raw.map((w) => (w * 10_000n) / sum);
  weights[first] += 10_000n - weights.reduce((a, b) => a + b, 0n);
  const total = spread(r(20), r(21), 9n, 11n);
  const drift = between(r(19), 500n, 6_000n);
  const stocks: RebalanceHolding[] = Array.from({ length: 7 }, (_, k) => {
    const f = (j: number) => r(30 + 10 * k + j);
    const price = between(f(0), 10n ** 9n, 10n ** 11n);
    const valueRaw =
      weights[k] > 0n
        ? (((total * weights[k]) / 10_000n) * between(f(1), 10_000n - drift, 10_000n + drift)) / 10_000n
        : f(2) % 4n === 0n
          ? spread(f(3), f(4), 6n, 10n)
          : 0n;
    const kind = f(5) % 4n;
    return {
      sharesRaw: (valueRaw * 10n ** 10n) / price,
      price,
      weightBps: weights[k],
      sellLeftRaw: kind === 0n ? 0n : kind === 1n ? spread(f(6), f(7), 4n, 9n) : 10n ** 18n,
    };
  });
  return {
    book: {
      stocks,
      usdcLeftRaw: r(22) % 5n === 0n ? spread(r(23), r(24), 6n, 9n) : 10n ** 15n,
      tradable: Array.from({ length: 7 }, (_, k) => r(100 + k) % 10n !== 0n),
    },
    bandBps: between(r(25), 500n, 5_000n),
    bandMaxBps: between(r(26), 100n, 2_000n),
    floorBps: between(r(27), 10n, 300n),
    minTradeRaw: between(r(28), 10n ** 6n, 100n * 10n ** 6n),
    maxSliceRaw: between(r(29), 100n * 10n ** 6n, 50_000n * 10n ** 6n),
  };
}

/** Top-ups' buys: the Rebalancer's book and options from `rebalanceInput`, and an amount from $1 to $90k. A tenth of the
 *  mixes hold nothing yet, and a fifth sit on target ($10k at their weights). Mirrors Vectors.investInput. */
export function investInput(i: number) {
  const r = (f: number) => rand("invest", i, f);
  const v = rebalanceInput(i);
  const empty = r(2) % 10n === 0n;
  const onTarget = r(3) % 5n === 0n;
  const stocks = v.book.stocks.map((h) =>
    empty
      ? { ...h, sharesRaw: 0n }
      : onTarget && h.weightBps > 0n
        ? { ...h, sharesRaw: (((10n ** 10n * h.weightBps) / 10_000n) * 10n ** 10n) / h.price }
        : h,
  );
  return { ...v, book: { ...v.book, stocks }, amountRaw: spread(r(0), r(1), 6n, 10n) };
}

/** Top-ups' counts: a state with Keep, what's ready and today, the mark and the agents' own change each 0 some of the
 *  time; then a save that finds savings at, under or over the mark, on the same day or the next; then a check on that
 *  day or the next with savings at, under or over the count's, and an invest of 0 to 100% of what's ready, with Aave's
 *  rounding. Mirrors Vectors.topUpsInput. */
export function topUpsInput(i: number) {
  const r = (f: number) => rand("topups", i, f);
  const some = (k: number, odds: bigint, lo: bigint, hi: bigint) =>
    r(k) % odds === 0n ? 0n : spread(r(k + 1), r(k + 2), lo, hi);
  const t: TopUpsState = {
    day: 20_000 + Number(r(0) % 3n),
    keepRaw: some(1, 4n, 6n, 10n),
    readyRaw: some(4, 3n, 5n, 10n),
    todayRaw: some(7, 3n, 5n, 10n),
    markRaw: some(10, 5n, 6n, 11n),
    ownRaw: some(13, 2n, 3n, 8n),
  };
  const near = (at: bigint, k: number) => {
    const move = spread(r(k + 1), r(k + 2), 4n, 10n);
    const kind = r(k) % 3n;
    return kind === 0n ? at : kind === 1n ? sub(at, move) : at + move;
  };
  const countDay = t.day + Number(r(16) % 2n);
  const beforeRaw = near(t.markRaw, 17);
  const savedRaw = spread(r(20), r(21), 5n, 10n);
  const savingsRaw = sub(beforeRaw + savedRaw, r(22) % 3n);
  return {
    t,
    countDay,
    beforeRaw,
    savedRaw,
    savingsRaw,
    checkDay: countDay + Number(r(23) % 2n),
    checkSavingsRaw: near(savingsRaw, 24),
    investPct: r(27) % 101n,
    roundingRaw: r(28) % 3n,
  };
}

/** Entry inputs: the four coins with balances from dust to $900k, daily limits that bind half the time, a coin
 *  waiting a fifth of the time. Mirrors Vectors.entryInput. */
export function entryInput(i: number) {
  const r = (f: number) => rand("entry", i, f);
  const coins: EntryCoin[] = ENTRY_COINS.map((c, k) => {
    const f = (j: number) => r(10 + 10 * k + j);
    const scale = 10n ** BigInt(c.decimals - 6);
    const kind = f(3) % 4n;
    return {
      balanceRaw: f(0) % 3n === 0n ? 0n : spread(f(1), f(2), 4n, 11n) * scale + (f(4) % scale),
      decimals: c.decimals,
      limitLeftRaw: kind === 0n ? 0n : kind === 1n ? spread(f(5), f(6), 5n, 10n) * scale : 10n ** 30n,
      waiting: f(7) % 5n === 0n,
    };
  });
  return {
    coins,
    floorBps: between(r(0), 10n, 100n),
    minEntryRaw: between(r(1), 100_000n, 100_000_000n),
    maxSwapRaw: between(r(2), 100n * 10n ** 6n, 100_000n * 10n ** 6n),
  };
}

/** Permission-hash inputs. Mirrors Vectors.hashInput. */
export function hashInput(i: number) {
  const r = (f: number) => rand("hash", i, f);
  const start = 1_700_000_000n + (r(2) % 300_000_000n);
  return {
    job: CASH_JOBS[Number(r(0) % 2n)],
    account: toHex(r(1) % 2n ** 160n, { size: 20 }) as Address,
    start,
    end: start + 1n + (r(3) % 400_000_000n),
    salt: r(4),
    cap: 1n + (r(5) % 5_000_000n),
  };
}

/** Protect · sell hash inputs: a hash input plus the stocks it may sell (no limit), a third of them never-sell, at least
 *  one for sale. */
export function sellHashInput(i: number) {
  const r = (f: number) => rand("sell-hash", i, f);
  const first = Number(r(6) % 7n);
  const limitsRaw: StockLimits = Array.from({ length: 7 }, (_, k) =>
    k !== first && r(7 + k) % 3n === 0n ? 0n : NO_LIMIT,
  );
  const start = 1_700_000_000n + (r(2) % 300_000_000n);
  return {
    account: toHex(r(1) % 2n ** 160n, { size: 20 }) as Address,
    start,
    end: start + 1n + (r(3) % 400_000_000n),
    salt: r(4),
    cap: 1n + (r(5) % 5_000_000n),
    limitsRaw,
  };
}

/** Rebalancer hash inputs: the stocks it may sell (no limit), a third of them unsellable, at least one sellable. */
export function rebalanceHashInput(i: number) {
  const r = (f: number) => rand("rebalance-hash", i, f);
  const first = Number(r(6) % 7n);
  const limitsRaw: StockLimits = Array.from({ length: 7 }, (_, k) =>
    k !== first && r(7 + k) % 3n === 0n ? 0n : NO_LIMIT,
  );
  const start = 1_700_000_000n + (r(2) % 300_000_000n);
  return {
    account: toHex(r(1) % 2n ** 160n, { size: 20 }) as Address,
    start,
    end: start + 1n + (r(3) % 400_000_000n),
    salt: r(4),
    cap: 1n + (r(5) % 5_000_000n),
    limitsRaw,
  };
}

/** Entry hash inputs. Mirrors Vectors.entryHashInput. */
export function entryHashInput(i: number) {
  const r = (f: number) => rand("entry-hash", i, f);
  const start = 1_700_000_000n + (r(2) % 300_000_000n);
  return {
    account: toHex(r(1) % 2n ** 160n, { size: 20 }) as Address,
    start,
    end: start + 1n + (r(3) % 400_000_000n),
    salt: r(4),
    cap: 1n + (r(5) % 5_000_000n),
  };
}

function protectVectors() {
  const kinds: number[] = [];
  const checkKind: number[] = [];
  const amounts: string[] = [];
  for (let i = 0; i < PROTECT_COUNT; i++) {
    const v = protectInput(i);
    const t = { triggerHf: toFloat(v.triggerHf, WAD), targetHf: toFloat(v.targetHf, WAD), rescuing: v.rescuing };
    const minRepayUsd = toFloat(v.minRepay, 1_000_000n);
    // Exact conversions, not summarize()'s cent rounding: the vectors test the rule, not the display.
    const totalBackingUsd = toFloat(v.collateral, VALUE_PER_USD);
    const avgCf = toFloat(v.avgCf, WAD);
    const debtUsd = toFloat(ceilDiv(v.debtRay, RAY), VALUE_PER_USD);
    const input = {
      totalBackingUsd,
      avgCf,
      debtUsd,
      savingsUsd: toFloat(v.savings, 1_000_000n),
      capLeftUsd: toFloat(v.capLeft, 1_000_000n),
      ...t,
    };
    const d = planProtect({ ...input, minRepayUsd });
    kinds.push(PROTECT_CASE[d.reason]);
    amounts.push(d.action === "repay" ? BigInt(Math.round(d.amountUsd * 1e6)).toString() : "0");
    // Float and integer maths may disagree within a hair of a threshold: those vectors check the amount only.
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    const hf = debtUsd > 0 ? (totalBackingUsd * avgCf) / debtUsd : Infinity;
    const uncapped = planProtect({ ...input, minRepayUsd: 0 });
    const line = v.rescuing ? t.targetHf : t.triggerHf;
    const edge = near(hf, line) || (uncapped.action === "repay" && near(uncapped.amountUsd, minRepayUsd));
    checkKind.push(edge ? 0 : 1);
  }
  return { kinds: hex(kinds), checkKind: hex(checkKind), amounts };
}

function saveVectors() {
  const kinds: number[] = [];
  const amounts: string[] = [];
  for (let i = 0; i < SAVE_COUNT; i++) {
    const v = saveInput(i);
    const d = planSave({
      walletRaw: v.cash,
      capLeftRaw: v.capLeft,
      savesToday: Number(v.savesToday),
      keepBackRaw: v.keepBack,
      minSaveRaw: v.minSave,
      maxSavesPerDay: Number(v.maxSavesPerDay),
    });
    kinds.push(SAVE_CASE[d.action === "save" ? "save" : d.reason]);
    amounts.push(d.action === "save" ? d.amountRaw.toString() : "0");
  }
  return { kinds: hex(kinds), amounts };
}

/** Leo's Friday window (plan.ts) and the app's "markets closed" (lib/market-hours), one bit per timestamp. */
function calendarVectors() {
  const window = new Array<number>(CALENDAR_COUNT / 8).fill(0);
  const frozen = new Array<number>(CALENDAR_COUNT / 8).fill(0);
  for (let i = 0; i < CALENDAR_COUNT; i++) {
    const at = new Date(Number(calendarTime(i)) * 1000);
    if (inWeekendWindow(at)) window[i >> 3] |= 0x80 >> (i & 7);
    if (!marketState(at).open) frozen[i >> 3] |= 0x80 >> (i & 7);
  }
  return { window: hex(window), frozen: hex(frozen) };
}

/** What planSell decides for each input: the amounts per stock, then the slices, flattened. */
function sellVectors() {
  const amounts: string[] = [];
  const counts: number[] = [];
  const reserves: number[] = [];
  const shares: string[] = [];
  const minOuts: string[] = [];
  for (let i = 0; i < SELL_COUNT; i++) {
    const v = sellInput(i);
    for (const a of sellAmounts(v.book, v)) amounts.push(a.toString());
    const { slices } = planSell(v.book, v);
    counts.push(slices.length);
    for (const s of slices) {
      reserves.push(s.reserveId);
      shares.push(s.sharesRaw.toString());
      minOuts.push(s.minOutRaw.toString());
    }
  }
  const timings: number[] = [];
  for (let i = 0; i < TIMING_COUNT; i++) {
    const v = timingInput(i);
    timings.push(sellsNow(v.hf, v.rescuing, v.frozen, v) ? 1 : 0);
  }
  return { amounts, counts: hex(counts), reserves: hex(reserves), shares, minOuts, timings: hex(timings) };
}

/** What rebalanceTrades decides for each input, flattened, and whether planRebalance trades (the pools in line). */
function rebalanceVectors() {
  const counts: number[] = [];
  const planned: number[] = [];
  const reserves: number[] = [];
  const buys: number[] = [];
  const amountIns: string[] = [];
  const minOuts: string[] = [];
  for (let i = 0; i < REBALANCE_COUNT; i++) {
    const v = rebalanceInput(i);
    const trades = rebalanceTrades(v.book, v);
    counts.push(trades.length);
    planned.push(planRebalance(v.book, v).length > 0 ? 1 : 0);
    for (const t of trades) {
      reserves.push(t.reserveId);
      buys.push(t.buy ? 1 : 0);
      amountIns.push(t.amountIn.toString());
      minOuts.push(t.minOut.toString());
    }
  }
  return { counts: hex(counts), planned: hex(planned), reserves: hex(reserves), buys: hex(buys), amountIns, minOuts };
}

/** What investTrades decides for each input, flattened: every trade is a buy. */
function investVectors() {
  const counts: number[] = [];
  const reserves: number[] = [];
  const amountIns: string[] = [];
  const minOuts: string[] = [];
  for (let i = 0; i < INVEST_COUNT; i++) {
    const v = investInput(i);
    const trades = investTrades(v.book, v.amountRaw, v);
    counts.push(trades.length);
    for (const t of trades) {
      reserves.push(t.reserveId);
      amountIns.push(t.amountIn.toString());
      minOuts.push(t.minOut.toString());
    }
  }
  return { counts: hex(counts), reserves: hex(reserves), amountIns, minOuts };
}

/** For each input: Save's count (what it counted, and the state after), then the check's ready amount, then the state
 *  after it invests. */
function topUpsVectors() {
  const out = {
    counted: [] as string[],
    countReady: [] as string[],
    countToday: [] as string[],
    countMark: [] as string[],
    countOwn: [] as string[],
    ready: [] as string[],
    investReady: [] as string[],
    investToday: [] as string[],
    investMark: [] as string[],
  };
  for (let i = 0; i < TOPUPS_COUNT; i++) {
    const v = topUpsInput(i);
    const a = topUpCounted(v.t, v.countDay, v.beforeRaw, v.savedRaw, v.savingsRaw);
    const b = topUpsReady(a.state, v.checkDay, v.checkSavingsRaw);
    const investRaw = (b.readyRaw * v.investPct) / 100n;
    const c = topUpInvested(b.state, investRaw, sub(v.checkSavingsRaw, investRaw + v.roundingRaw));
    out.counted.push(a.countedRaw.toString());
    out.countReady.push(a.state.readyRaw.toString());
    out.countToday.push(a.state.todayRaw.toString());
    out.countMark.push(a.state.markRaw.toString());
    out.countOwn.push(a.state.ownRaw.toString());
    out.ready.push(b.readyRaw.toString());
    out.investReady.push(c.readyRaw.toString());
    out.investToday.push(c.todayRaw.toString());
    out.investMark.push(c.markRaw.toString());
  }
  return out;
}

/** What planEntry decides for each input: the coin (255 for none), what it swaps and the floor. */
function entryVectors() {
  const indexes: number[] = [];
  const amountIns: string[] = [];
  const minOuts: string[] = [];
  for (let i = 0; i < ENTRY_COUNT; i++) {
    const v = entryInput(i);
    const m = planEntry(v.coins, v);
    indexes.push(m ? m.index : 255);
    amountIns.push(m ? m.amountIn.toString() : "0");
    minOuts.push(m ? m.minOut.toString() : "0");
  }
  return { indexes: hex(indexes), amountIns, minOuts };
}

/** The manager's EIP-712 hash (getHash) of a permission, as `getHash` computes it on Base. */
function managerHash(p: ReturnType<typeof agentPermission>) {
  return hashTypedData({
    domain: {
      name: "JustaPermissionManager",
      version: "1",
      chainId: 8453,
      verifyingContract: PROTOCOLS.PERMISSION_MANAGER,
    },
    types: {
      Permission: [
        { name: "account", type: "address" },
        { name: "spender", type: "address" },
        { name: "start", type: "uint48" },
        { name: "end", type: "uint48" },
        { name: "salt", type: "uint256" },
        { name: "calls", type: "CallPermission[]" },
        { name: "spends", type: "SpendLimit[]" },
      ],
      CallPermission: [
        { name: "target", type: "address" },
        { name: "selector", type: "bytes4" },
        { name: "checker", type: "address" },
      ],
      SpendLimit: [
        { name: "token", type: "address" },
        { name: "allowance", type: "uint160" },
        { name: "unit", type: "uint8" },
        { name: "multiplier", type: "uint16" },
      ],
    },
    primaryType: "Permission",
    message: p,
  });
}

/**
 * The manager's hash of the permission JAW grants for each input, for every job (every allowance NO_LIMIT, decision 9),
 * and the bytes the app registers for the first input of each kind (`registrations`: abi.encode(permission),
 * lib/agents/register.ts), which GooseGuard's `register(job, permission)` stores as they are.
 */
function hashVectors() {
  const firsts: Parameters<typeof encodePermission>[0][] = [];
  const hashed = (i: number, p: Parameters<typeof encodePermission>[0]) => {
    if (i === 0) firsts.push(p);
    return managerHash(p);
  };
  const hashes = [];
  for (let i = 0; i < HASH_COUNT; i++) {
    const v = hashInput(i);
    hashes.push(
      hashed(
        i,
        agentPermission(v.job, {
          account: v.account,
          spender: HASH_SPENDER,
          start: Number(v.start),
          end: Number(v.end),
          salt: v.salt,
        }),
      ),
    );
  }
  const sellHashes = [];
  for (let i = 0; i < HASH_COUNT; i++) {
    const v = sellHashInput(i);
    sellHashes.push(
      hashed(
        i,
        sellPermission({
          account: v.account,
          spender: HASH_SPENDER,
          start: Number(v.start),
          end: Number(v.end),
          salt: v.salt,
          limitsRaw: v.limitsRaw,
        }),
      ),
    );
  }
  const rebalanceHashes = [];
  for (let i = 0; i < HASH_COUNT; i++) {
    const v = rebalanceHashInput(i);
    rebalanceHashes.push(
      hashed(
        i,
        rebalancePermission({
          account: v.account,
          spender: HASH_SPENDER,
          start: Number(v.start),
          end: Number(v.end),
          salt: v.salt,
          limitsRaw: v.limitsRaw,
        }),
      ),
    );
  }
  const entryHashes = [];
  for (let i = 0; i < HASH_COUNT; i++) {
    const v = entryHashInput(i);
    entryHashes.push(
      hashed(
        i,
        entryPermission({
          account: v.account,
          spender: HASH_SPENDER,
          start: Number(v.start),
          end: Number(v.end),
          salt: v.salt,
        }),
      ),
    );
  }
  const registrations = firsts.map(encodePermission);
  return {
    spender: HASH_SPENDER,
    hashes,
    sellHashes,
    rebalanceHashes,
    entryHashes,
    registrations,
  };
}

/** config/risk.ts in on-chain units: the executor's deploy defaults must match. */
function defaultsVector() {
  const wad = (x: number) => parseUnits(x.toFixed(4), 18).toString();
  const usdc = (x: number) => parseUnits(x.toFixed(6), 6).toString();
  return {
    /** The bands the contract's hard bounds sit on (CashRulesTest.test_the_bounds_sit_on_the_apps_bands). */
    risk: { watchMin: wad(RISK.watchMin), safeMin: wad(RISK.safeMin) },
    triggerHf: wad(CASH_AGENT.triggerHf),
    targetHf: wad(CASH_AGENT.targetHf),
    stressDrop: wad(CASH_AGENT.stressDrop),
    stressFloorHf: wad(CASH_AGENT.stressFloorHf),
    minRepay: usdc(CASH_AGENT.minRepayUsd),
    minSave: usdc(CASH_AGENT.minSaveUsd),
    keepBack: usdc(CASH.keepBackUsd),
    weekendWindow: CASH_AGENT.weekendWindowSec.toString(),
    maxSavesPerDay: CASH_AGENT.maxSavesPerDay.toString(),
    sell: {
      floorBps: PROTECT_SELL.floorBps.toString(),
      poolCap: usdc(PROTECT_SELL.poolCapUsd),
      maxSlice: usdc(PROTECT_SELL.maxSliceUsd),
    },
    rebalance: {
      bandBps: Math.round(REBALANCER.bandOfTarget * 10_000).toString(),
      bandMaxBps: Math.round(REBALANCER.bandMaxPoints * 100).toString(),
      poolGapBps: REBALANCER.poolGapBps.toString(),
      floorBps: REBALANCER.floorBps.toString(),
      minTrade: usdc(REBALANCER.minTradeUsd),
      maxSlice: usdc(REBALANCER.maxSliceUsd),
    },
    entry: {
      floorBps: ENTRY.floorBps.toString(),
      minEntry: usdc(ENTRY.minEntryUsd),
      maxSwap: usdc(ENTRY.maxSwapUsd),
    },
  };
}

/** Every vector file, by name under contracts/test/vectors/. */
export function agentVectors(): Record<string, unknown> {
  return {
    "protect.json": protectVectors(),
    "save.json": saveVectors(),
    "calendar.json": calendarVectors(),
    "sell.json": sellVectors(),
    "rebalance.json": rebalanceVectors(),
    "invest.json": investVectors(),
    "topups.json": topUpsVectors(),
    "entry.json": entryVectors(),
    "permissions.json": hashVectors(),
    "defaults.json": defaultsVector(),
  };
}

if (process.argv[1]?.endsWith("agent-vectors.ts")) {
  for (const [name, data] of Object.entries(agentVectors())) {
    writeFileSync(new URL(`../contracts/test/vectors/${name}`, import.meta.url), JSON.stringify(data) + "\n");
  }
}

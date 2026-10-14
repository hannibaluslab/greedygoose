/**
 * Test vectors that tie GooseExecutor's Solidity to the TypeScript reference (contracts/docs/GooseExecutor.md §5, §7,
 * §11). Inputs come from keccak256(abi.encode(tag, i, field)) on both sides (contracts/test/Vectors.sol), so the
 * JSON only carries what TypeScript decided. Forge reads it with vm.parseJson.
 *
 *   npm run contracts:vectors   # rewrite contracts/test/vectors/*.json after changing a rule
 *
 * tests/unit/agents.test.ts fails while the committed files are stale.
 */
import { writeFileSync } from "node:fs";
import { encodeAbiParameters, hashTypedData, keccak256, parseUnits, toHex, type Address } from "viem";
import { CASH, CASH_AGENT, PROTECT_SELL } from "@/config/risk";
import { GUARDIAN } from "@/lib/guardian/config";
import { inWeekendWindow, planGuardian, planSave } from "@/lib/guardian/plan";
import { planSell, sellAmounts, sellTiming, type SellBook } from "@/lib/guardian/sell";
import { marketState } from "@/lib/market-hours";
import { agentPermission, JOBS, sellPermission, STOCK_LIMIT_UNIT, type StockLimits } from "@/lib/agents/permissions";

const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const VALUE_PER_USD = 10n ** 26n;
const DAY = 86_400n;

/** The same draw as Vectors.sol: uint256(keccak256(abi.encode(tag, i, field))). */
const rand = (tag: string, i: number, field: number) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "uint256" }], [tag, BigInt(i), BigInt(field)])));
const between = (r: bigint, lo: bigint, hi: bigint) => lo + (r % (hi - lo + 1n));
/** A wide spread of magnitudes: (1 to 9) × 10^(lo to hi). */
const spread = (r1: bigint, r2: bigint, lo: bigint, hi: bigint) => (1n + (r1 % 9n)) * 10n ** between(r2, lo, hi);
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const toFloat = (v: bigint, unit: bigint) => Number(v) / Number(unit);
const hex = (bytes: number[]) => toHex(Uint8Array.from(bytes));

/** ProtectCase in CashRules.sol. */
const PROTECT_CASE = { "no-debt": 0, healthy: 1, "no-savings": 2, "no-cap": 3, "too-small": 4, watch: 5, "weekend-shield": 6 } as const;
/** SaveCase in CashRules.sol. */
const SAVE_CASE = { "too-small": 0, "no-cap": 1, rate: 2, save: 3 } as const;

export const PROTECT_COUNT = 1000;
export const SAVE_COUNT = 1000;
export const CALENDAR_COUNT = 10_000;
export const HASH_COUNT = 50;
export const SELL_COUNT = 600;
export const TIMING_COUNT = 1000;
/** Where Vectors.sol's hash test puts the executor, so both sides know the spender. */
export const HASH_SPENDER: Address = "0x0000000000000000000000000000000000600dE5";

/** Protect inputs, in on-chain units. Mirrors Vectors.protectInput. A quarter of them sit between the trigger and
 *  the weekend floor before a freeze, where only Weekend Shield acts. */
export function protectInput(i: number) {
  const r = (f: number) => rand("protect", i, f);
  const triggerHf = between(r(14), (WAD * 12n) / 10n, 2n * WAD);
  const targetHf = between(r(15), triggerHf + WAD / 20n, (WAD * 25n) / 10n);
  const stressDrop = between(r(16), WAD / 20n, (WAD * 3n) / 10n);
  const shield = r(19) % 4n === 0n;
  // Weekend Shield needs a floor above the stressed trigger: floor > triggerHf × (1 − stressDrop).
  const stressed = (triggerHf * (WAD - stressDrop)) / WAD;
  const floorMin = shield && stressed >= (WAD * 102n) / 100n ? stressed + 1n : (WAD * 102n) / 100n;
  const stressFloorHf = between(r(17), floorMin, triggerHf);
  const hf = shield
    ? between(r(4), triggerHf, (stressFloorHf * WAD) / (WAD - stressDrop))
    : between(r(4), (WAD * 8n) / 10n, (WAD * 26n) / 10n);

  const collateral = spread(r(0), r(1), 1n, 6n) * VALUE_PER_USD + (r(2) % VALUE_PER_USD);
  const avgCf = between(r(3), WAD / 2n, (WAD * 85n) / 100n);
  const debtValue = (((collateral * avgCf) / WAD) * WAD) / hf;
  const debtRay = r(6) % 20n === 0n ? 0n : debtValue * RAY + (r(5) % RAY);
  const savings = r(7) % 10n === 0n ? 0n : spread(r(8), r(9), 5n, 11n);
  const capLeft = r(10) % 10n === 0n ? 0n : spread(r(11), r(12), 5n, 10n);
  const preFreeze = shield || r(13) % 2n === 1n;
  const minRepay = 50_000n * 10n ** (r(18) % 4n);
  return { collateral, avgCf, debtRay, savings, capLeft, preFreeze, triggerHf, targetHf, stressDrop, stressFloorHf, minRepay };
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
 *  $100–1,000, health from 0.95 to 1.6, and limits, pool windows and the USDC limit that bind a fifth of the time. */
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
  const hf = between(r(1), (WAD * 95n) / 100n, (WAD * 16n) / 10n);
  const power = stocks.reduce((p, s) => p + s.cfBps * s.sharesRaw * s.price * 10n ** 10n, 0n);
  const book: SellBook = {
    stocks,
    debtValue: ceilDiv(power * 10n ** 14n, hf),
    usdcPrice,
    usdcLeftRaw: r(2) % 5n === 0n ? spread(r(3), r(4), 5n, 9n) : 10n ** 13n,
  };
  return {
    book,
    targetHf: between(r(5), (WAD * 13n) / 10n, (WAD * 16n) / 10n),
    floorBps: between(r(6), 25n, 500n),
    keepMix: r(7) % 3n === 0n,
    maxSliceRaw: between(r(8), 100n * 10n ** 6n, 50_000n * 10n ** 6n),
  };
}

/** Protect · sell timing inputs. Mirrors Vectors.timingInput. */
export function timingInput(i: number) {
  const r = (f: number) => rand("timing", i, f);
  const now = 1_792_000_000n;
  const headsUpHf = between(r(0), (WAD * 11n) / 10n, (WAD * 15n) / 10n);
  return {
    hf: between(r(1), (WAD * 9n) / 10n, (WAD * 16n) / 10n),
    headsUpAt: r(2) % 3n === 0n ? 0n : now - (r(3) % 7_200n),
    now,
    frozen: r(4) % 4n === 0n,
    headsUpHf,
    nowHf: between(r(5), (WAD * 102n) / 100n, headsUpHf),
    headsUpDelaySec: between(r(6), 600n, 7_200n),
  };
}

/** Permission-hash inputs. Mirrors Vectors.hashInput. */
export function hashInput(i: number) {
  const r = (f: number) => rand("hash", i, f);
  const start = 1_700_000_000n + (r(2) % 300_000_000n);
  return {
    job: JOBS[Number(r(0) % 2n)],
    account: toHex(r(1) % 2n ** 160n, { size: 20 }) as Address,
    start,
    end: start + 1n + (r(3) % 400_000_000n),
    salt: r(4),
    cap: 1n + (r(5) % 5_000_000n),
  };
}

/** Protect · sell hash inputs: a hash input plus a daily limit per stock, a third of them never-sell, at least one
 *  for sale. Mirrors Vectors.sellHashInput. */
export function sellHashInput(i: number) {
  const r = (f: number) => rand("sell-hash", i, f);
  const first = Number(r(6) % 7n);
  const limitsRaw: StockLimits = Array.from({ length: 7 }, (_, k) =>
    k !== first && r(7 + k) % 3n === 0n ? 0n : (1n + (r(14 + k) % 1_000_000n)) * STOCK_LIMIT_UNIT,
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

function protectVectors() {
  const kinds: number[] = [];
  const checkKind: number[] = [];
  const amounts: string[] = [];
  for (let i = 0; i < PROTECT_COUNT; i++) {
    const v = protectInput(i);
    const t = { triggerHf: toFloat(v.triggerHf, WAD), targetHf: toFloat(v.targetHf, WAD), stressDrop: toFloat(v.stressDrop, WAD), stressFloorHf: toFloat(v.stressFloorHf, WAD) };
    const minRepayUsd = toFloat(v.minRepay, 1_000_000n);
    // Exact conversions, not summarize()'s cent rounding: the vectors test the rule, not the display.
    const collateralUsd = toFloat(v.collateral, VALUE_PER_USD);
    const avgCf = toFloat(v.avgCf, WAD);
    const debtUsd = toFloat(ceilDiv(v.debtRay, RAY), VALUE_PER_USD);
    const input = {
      collateralUsd,
      avgCf,
      debtUsd,
      savingsUsd: toFloat(v.savings, 1_000_000n),
      capLeftUsd: toFloat(v.capLeft, 1_000_000n),
      weekendWindow: v.preFreeze,
      ...t,
    };
    const d = planGuardian({ ...input, minRepayUsd });
    kinds.push(PROTECT_CASE[d.reason]);
    amounts.push(d.action === "repay" ? BigInt(Math.round(d.amountUsd * 1e6)).toString() : "0");
    // Float and integer maths may disagree within a hair of a threshold: those vectors check the amount only.
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    const hf = debtUsd > 0 ? (collateralUsd * avgCf) / debtUsd : Infinity;
    const uncapped = planGuardian({ ...input, minRepayUsd: 0 });
    const edge =
      near(hf, t.triggerHf) ||
      (v.preFreeze && near(hf * (1 - t.stressDrop), t.stressFloorHf)) ||
      (uncapped.action === "repay" && near(uncapped.amountUsd, minRepayUsd));
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
    const t = sellTiming(v.hf, v.headsUpAt, v.now, v.frozen, v);
    timings.push(["wait", "heads-up", "clear", "sell"].indexOf(t.timing) * 2 + (t.atOnce ? 1 : 0));
  }
  return { amounts, counts: hex(counts), reserves: hex(reserves), shares, minOuts, timings: hex(timings) };
}

/** The manager's EIP-712 hash (getHash) of a permission, as `getHash` computes it on Base. */
function managerHash(p: ReturnType<typeof agentPermission>) {
  return hashTypedData({
    domain: { name: "JustaPermissionManager", version: "1", chainId: 8453, verifyingContract: GUARDIAN.PERMISSION_MANAGER },
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

/** The manager's hash of the permission JAW grants for each input, for the Cash jobs and for Protect · sell. */
function hashVectors() {
  const hashes = [];
  for (let i = 0; i < HASH_COUNT; i++) {
    const v = hashInput(i);
    hashes.push(managerHash(agentPermission(v.job, { account: v.account, spender: HASH_SPENDER, start: Number(v.start), end: Number(v.end), salt: v.salt, capRaw: v.cap })));
  }
  const sellHashes = [];
  for (let i = 0; i < HASH_COUNT; i++) {
    const v = sellHashInput(i);
    sellHashes.push(
      managerHash(
        sellPermission({ account: v.account, spender: HASH_SPENDER, start: Number(v.start), end: Number(v.end), salt: v.salt, capRaw: v.cap, limitsRaw: v.limitsRaw }),
      ),
    );
  }
  return { spender: HASH_SPENDER, hashes, sellHashes };
}

/** config/risk.ts in on-chain units: the executor's deploy defaults must match. */
function defaultsVector() {
  const wad = (x: number) => parseUnits(x.toFixed(4), 18).toString();
  const usdc = (x: number) => parseUnits(x.toFixed(6), 6).toString();
  return {
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
      headsUpHf: wad(PROTECT_SELL.headsUpHf),
      nowHf: wad(PROTECT_SELL.nowHf),
      targetHf: wad(PROTECT_SELL.targetHf),
      headsUpDelay: PROTECT_SELL.headsUpDelaySec.toString(),
      floorBps: PROTECT_SELL.floorBps.toString(),
      actFloorBps: PROTECT_SELL.actFloorBps.toString(),
      poolCap: usdc(PROTECT_SELL.poolCapUsd),
      maxSlice: usdc(PROTECT_SELL.maxSliceUsd),
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
    "permissions.json": hashVectors(),
    "defaults.json": defaultsVector(),
  };
}

if (process.argv[1]?.endsWith("agent-vectors.ts")) {
  for (const [name, data] of Object.entries(agentVectors())) {
    writeFileSync(new URL(`../contracts/test/vectors/${name}`, import.meta.url), JSON.stringify(data) + "\n");
  }
}

import { decodeFunctionData, erc20Abi, isAddressEqual, parseUnits } from "viem";
import { ACT_LINE, RISK, pastStop, type CreditLine } from "@/config/risk";
import { swapOf } from "@/lib/allowlist";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { autoFill, combinedCredit, fillRaw, type BackingLine } from "@/lib/aave/credit";
import { buildBackAndCreditCalls, type Call } from "@/lib/aave/tx";
import { cashRaw, feeBufferRaw, maxSpendRaw, payFromCash, toUsd, type Cash } from "@/lib/cash";
import {
  CREDIT_BLOCKED,
  LINE_MOVED,
  creditLine,
  noCreditLine,
  type CreditBlock,
  type NoCredit,
} from "./creditBuy/copy";
import { floorCents } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import type { ActivityItem } from "@/lib/activity/decode";
import { STATUS_LABEL, endsInAct, needsExtraConfirm, statusFor, type Status } from "@/lib/risk/status";
import { BUY_LIMITS, buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import type { HealthFloor } from "@/lib/tx/prepared";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

export * from "./creditBuy/copy";

type Address = `0x${string}`;

/** A free holding that can back credit, valued at Aave's price. */
export type BackingOption = { stock: ReserveAsset; freeRaw: bigint; freeUsd: number; cf: number };
/** Free stock put in use as backing, in the same batch. */
export type Backing = { stock: ReserveAsset; raw: bigint };
/**
 * Credit Buy goes backing first (Adrian, 2026-10-15): the holding picked to back it and exactly how much of it goes in
 * use. No option, or 0n, puts nothing new in use: only what already backs credit counts.
 */
export type BackingPick = { option: BackingOption | null; raw: bigint };
/**
 * What a Credit Buy batch may not go past (assertCreditBuy): each backing's free shares, as the screen read them, and
 * the most credit that backing and what already backs credit allow (creditCap: Act is the line).
 */
export type CreditLimit = { maxCreditRaw: bigint; freeRaw: Readonly<Record<string, bigint>> };

/** Free stock worth less than a cent can't back a Credit Buy: no minimum of ours (ruling 2, Oct 17). */
export const MIN_BACKING_USD = 0.01;

/** Free holdings that can back credit: a collateral factor, not paused or frozen. */
export function backingOptions(
  holdings: readonly { symbol: string; freeRaw: bigint; freeUsd: number; paused: boolean; frozen: boolean }[],
  cfs: Record<string, number>,
): BackingOption[] {
  return holdings.flatMap((h) => {
    const stock = EQUITIES.find((e) => e.symbol === h.symbol);
    const cf = cfs[h.symbol] ?? 0;
    return stock && h.freeUsd >= 0.01 && cf > 0 && !h.paused && !h.frozen
      ? [{ stock, freeRaw: h.freeRaw, freeUsd: h.freeUsd, cf }]
      : [];
  });
}

/**
 * What backs credit once a Credit Buy lands: the holdings `adding` puts in use and every holding already in use,
 * `lead` first (the one picked to back it) when it is among them.
 */
export function backers<H extends { symbol: string; backingRaw: bigint }>(
  holdings: readonly H[],
  adding: readonly string[],
  lead?: string,
): H[] {
  const backs = holdings.filter((h) => adding.includes(h.symbol) || h.backingRaw > 0n);
  const rank = (h: H) => (h.symbol === lead ? 0 : adding.includes(h.symbol) ? 1 : 2);
  return backs.sort((a, b) => rank(a) - rank(b));
}

/** The position fields the plan reads (usePosition's data has them all). */
export type CreditPosition = {
  totalBackingUsd: number;
  avgCf: number;
  debtUsd: number;
  healthFactor: number | null;
  usdcLiquidity: number;
  creditPaused: boolean;
  /** How low credit may take the health (usePosition reads it: Protector's switch, the Wall open). ACT_LINE without. */
  line?: CreditLine;
};

/** The position's line: ACT_LINE (1.12, Act is the line) unless it says otherwise. */
export const lineOf = (pos: { line?: CreditLine }): CreditLine => pos.line ?? ACT_LINE;

/**
 * Every batch that takes credit (Credit Buy, decision 1, Earn with stocks) is stopped if the health on Aave after it,
 * read in its own simulation, is under the line's stop: in Act (ACT_LINE), or under Protector's line or Aave's once a
 * plan may end in Act. The screen's cap is planned on the position as last read, Aave lets credit go down to 1.0, and a
 * cut in a stock's collateral factor lands when the credit is taken (lib/tx/prepared.ts HealthFloor).
 */
export const creditFloor = (line: CreditLine): HealthFloor => ({
  minHf: line.stopHf,
  stop: line.intoAct ? LINE_MOVED : CREDIT_BLOCKED.act,
});

/** Under ACT_LINE: stopped in Act. */
export const CREDIT_FLOOR = creditFloor(ACT_LINE);

export type CreditPlan = {
  creditRaw: bigint;
  /** Free stock to put in use first; empty when what already backs credit covers it. */
  backing: (Backing & { usd: number })[];
  /** What the batch is checked against: this backing's free shares and the most credit it allows (assertCreditBuy). */
  limit: CreditLimit;
  before: Status;
  after: Status;
  hfAfter: number;
  /**
   * The screen needs the risk tick before anything is prepared: it ends in Watch (D2), or in Act where the line allows
   * it (intoAct). Under ACT_LINE ending in Act is a block instead ("act"), never a tick.
   */
  extraConfirm: boolean;
  /**
   * It ends in Act, which the line allows once Greedy Fatalities is open: the screen shows the Wall's rule and asks for
   * one tick before anything is prepared.
   */
  intoAct: boolean;
  /** What the batch's simulation is held to (creditFloor of the position's line). */
  floor: HealthFloor;
  /**
   * Most credit with every option in use (or, with an explicit pick, with that pick in use): staying Safe, and the MAX
   * (creditCap: health at or above the line's cap, so it ends in Watch at most under ACT_LINE).
   */
  maxSafeUsd: number;
  maxUsd: number;
  /** Markets are closed: still allowed (Aave allows it), and the screen must say the price may move when they reopen (CLAUDE.md › Market hours). */
  priceMayMove: boolean;
  /** Why it can't go ahead. */
  block?: CreditBlock;
};

const creditInputOf = (pos: CreditPosition) => ({
  totalBackingUsd: pos.totalBackingUsd,
  avgCf: pos.avgCf,
  debtUsd: pos.debtUsd,
  liquidityUsd: pos.usdcLiquidity,
  capHf: lineOf(pos).capHf,
});
const backingLine = (o: BackingOption, usd: number) => ({ key: o.stock.symbol, usd, cf: o.cf, freeUsd: o.freeUsd });

/**
 * The one cap on taking credit (Act is the line, Adrian 2026-10-15), for every way of taking it: Credit Buy, decision
 * 1's "Use credit for the other $Y", Earn with stocks, and every figure that says how much (usePosition's
 * `availableUsd`, Invest's buying power, "You can use up to", MAX and "Up to"). With `lines` put in use and
 * no credit taken yet: the most credit that keeps the health factor at or above the line's cap (combinedCredit's
 * maxCredit: net of what's owed, within what can be lent), so under ACT_LINE a plan may end in Watch but never in Act,
 * and the most that stays Safe. In cents, rounded down. Nothing while the credit is under the line's stop (in Act,
 * under ACT_LINE): more is blocked until it's back over it.
 */
export function creditCap(
  pos: CreditPosition,
  lines: readonly BackingLine[] = [],
): { maxUsd: number; maxSafeUsd: number } {
  if (pastStop(pos.healthFactor, lineOf(pos))) return { maxUsd: 0, maxSafeUsd: 0 };
  const all = combinedCredit({ ...creditInputOf(pos), creditUsd: 0, lines: [...lines] });
  return { maxUsd: floorCents(all.maxCredit), maxSafeUsd: floorCents(all.maxSafe) };
}

/** The most credit with every option in use (creditCap): the MAX and the most that stays Safe. */
function creditReach(pos: CreditPosition, options: readonly BackingOption[]): { maxUsd: number; maxSafeUsd: number } {
  return reachWith(
    pos,
    options.map((o) => backingLine(o, o.freeUsd)),
  );
}

/** creditCap with these lines in use. */
const reachWith = (pos: CreditPosition, lines: BackingLine[]) => creditCap(pos, lines);

/** The value of `raw` of a free holding, at the price its free value was read at. */
const usdOf = (o: BackingOption, raw: bigint) => (o.freeRaw > 0n ? (o.freeUsd * Number(raw)) / Number(o.freeRaw) : 0);
const usdcRaw = (usd: number) => parseUnits(Math.max(0, usd).toFixed(USDC.decimals), USDC.decimals);

/** A holding's free value as step 2's MAX fills it in: floored to the cent, so it is never more than is free. */
export const freeShownUsd = (option: BackingOption) => floorCents(option.freeUsd);

/**
 * Whether dollars typed in step 2 are all of the holding's free value: from the cent it's shown at (MAX's figure, or
 * half a cent under, whichever is lower) up to half a cent over it. Step 2 turns it into "all of it" when it's typed,
 * so a later price move can neither make it more than is free nor leave dust behind. Clearly more stays more.
 */
export function isAllFree(option: BackingOption, usd: number): boolean {
  if (!(usd > 0) || option.freeRaw <= 0n || option.freeUsd <= 0) return false;
  return usd >= Math.min(freeShownUsd(option), option.freeUsd - 0.005) && usd <= option.freeUsd + 0.005;
}

/**
 * "How much to put in use", typed in dollars, in raw units of the holding: in proportion to its free value. All of it
 * (`isAllFree`) is exactly `freeRaw`, so no dust is left behind; more than it stays more, for the plan to block
 * ("over-free"). MAX passes the free shares straight through, not dollars.
 */
export function backingRawFor(option: BackingOption, usd: number): bigint {
  if (!(usd > 0) || option.freeRaw <= 0n || option.freeUsd <= 0) return 0n;
  if (isAllFree(option, usd)) return option.freeRaw;
  return (option.freeRaw * BigInt(Math.round(usd * 1e6))) / BigInt(Math.max(1, Math.round(option.freeUsd * 1e6)));
}

/**
 * What a stock can back on its own, all of its free shares at the line (boards 30–34, "Back new credit with"): its free
 * value × its backing factor ÷ the line's cap (1.12 under ACT_LINE), in dollars rounded down to the cent. Credit ready (what already backs credit) is
 * its own choice, so this never counts it; and never more than the whole position allows with it in (creditWith: what
 * Aave has to lend, and what's owed past the line already).
 */
export const ownCreditUsd = (position: CreditPosition, option: BackingOption) =>
  floorCents(
    Math.max(0, Math.min((option.freeUsd * option.cf) / lineOf(position).capHf, creditWith(position, option))),
  );

/**
 * The backing a Credit Buy of `creditUsd` puts in with `option` (boards 31–33): just enough of the stock for the buy to
 * stay Safe on its own (its value × backing factor ÷ the credit ≥ Safe's line), never more than its free shares; when
 * that's not enough, all of them, and the buy may end in Watch. Nothing for no credit.
 */
export function backingForBuy(option: BackingOption, creditUsd: number): bigint {
  if (!(creditUsd > 0) || option.cf <= 0) return 0n;
  return backingRawFor(option, Math.min(option.freeUsd, (creditUsd * RISK.safeMin) / option.cf));
}

/**
 * The most one Credit Buy can use with all of `option` in use and what already backs credit (planCredit's MAX with that
 * one option: step 2's MAX on it). Without `option`, the credit left on what already backs credit alone (step 1's "Already
 * backs credit" row).
 */
export function creditWith(position: CreditPosition, option?: BackingOption): number {
  return creditReach(position, option ? [option] : []).maxUsd;
}

/**
 * The holding step 1 ("Back it with") picks until Sam picks another: the one a Credit Buy can use the most with (ties:
 * the most free stock). Its figure is Invest's buying power in credit (creditAvailable) and step 2's MAX on it.
 */
export function bestBacking(
  position: CreditPosition,
  options: readonly BackingOption[],
): { option: BackingOption; usd: number } | null {
  let best: { option: BackingOption; usd: number } | null = null;
  for (const option of options) {
    const usd = creditWith(position, option);
    if (!best || usd > best.usd || (usd === best.usd && option.freeUsd > best.option.freeUsd)) best = { option, usd };
  }
  return best;
}

/**
 * The line's own blocks on taking credit. Under ACT_LINE, Act is the line: credit taken while in Act, or credit that
 * would end in Act, is blocked outright (no risk tick). Once a plan may end in Act, only credit taken under the line's
 * stop is ("past-limit"); past the cap is "too-much".
 */
function lineBlock(healthFactor: number | null, after: Status, line: CreditLine): CreditBlock | undefined {
  if (pastStop(healthFactor, line)) return line.intoAct ? "past-limit" : "in-act";
  if (!line.intoAct && endsInAct(after)) return "act";
  return undefined;
}

/** Why a plan can't go ahead, first match: Aave's state, the free shares, the line, the cap, the network fee. */
function creditBlockOf(q: {
  pos: CreditPosition;
  creditUsd: number;
  overFree: boolean;
  after: Status;
  line: CreditLine;
  maxUsd: number;
  cash: Cash;
}): CreditBlock | undefined {
  if (q.pos.creditPaused) return "paused";
  if (q.creditUsd > q.pos.usdcLiquidity) return "no-liquidity";
  if (q.overFree) return "over-free";
  const byLine = q.creditUsd > 0 ? lineBlock(q.pos.healthFactor, q.after, q.line) : undefined;
  if (byLine) return byLine;
  if (q.creditUsd > q.maxUsd) return "too-much";
  if (cashRaw(q.cash) < feeBufferRaw) return "fee";
  return undefined;
}

/**
 * What backs `creditRaw` of credit and the status it ends in, on Leo's credit maths.
 *
 * With `backing` (Credit Buy, backing first): exactly that pick goes in use, and the credit it can take is what it and what already
 * backs credit allow (creditCap). More than its free shares is blocked ("over-free"); 0n uses only what already backs
 * credit.
 *
 * Without it (decision 1, Earn with stocks): what already backs credit counts first; autoFill tops up from `options`
 * (highest collateral factor first) so the position starts Safe, with FILL_MARGIN on top. Past Safe, everything in
 * `options` goes in and the screen asks for the risk tick.
 *
 * Plan only: the batch is checked against `limit` and simulated before JAW's sheet.
 */
export function planCredit(
  p: { position: CreditPosition; creditRaw: bigint; cash: Cash; now?: Date } & (
    | { options: readonly BackingOption[]; backing?: undefined }
    | { backing: BackingPick; options?: undefined }
  ),
): CreditPlan {
  const pos = p.position;
  const creditUsd = toUsd(p.creditRaw);
  const creditInput = creditInputOf(pos);

  let chosen: { option: BackingOption; raw: bigint; usd: number }[];
  let reach: { maxUsd: number; maxSafeUsd: number };
  let overFree = false;
  if (p.backing) {
    const { option, raw: want } = p.backing;
    overFree = want > (option?.freeRaw ?? 0n);
    const raw = option ? (want < option.freeRaw ? want : option.freeRaw) : 0n;
    chosen = option && raw > 0n ? [{ option, raw, usd: usdOf(option, raw) }] : [];
    reach = reachWith(
      pos,
      chosen.map((c) => backingLine(c.option, c.usd)),
    );
  } else {
    const options = p.options;
    const fill = autoFill({ ...creditInput, creditUsd: creditUsd, lines: options.map((o) => backingLine(o, 0)) });
    chosen = options.flatMap((o) => {
      const raw = fillRaw(o.freeRaw, o.freeUsd, fill[o.stock.symbol]);
      return raw > 0n ? [{ option: o, raw, usd: usdOf(o, raw) }] : [];
    });
    reach = creditReach(pos, options);
  }
  const lines = chosen.map((c) => backingLine(c.option, c.usd));
  const calc = combinedCredit({ ...creditInput, creditUsd: creditUsd, lines: lines });
  const { maxUsd, maxSafeUsd } = reach;
  const after = statusFor(pos.debtUsd + creditUsd > 0 ? calc.hfAfter : null);
  // The batch’s own ceiling: the credit with exactly the backing it puts in use (for an explicit pick, maxUsd itself).
  const limit: CreditLimit = {
    maxCreditRaw: usdcRaw(p.backing ? maxUsd : reachWith(pos, lines).maxUsd),
    freeRaw: Object.fromEntries(chosen.map((c) => [c.option.stock.symbol, c.option.freeRaw])),
  };

  const line = lineOf(pos);
  const before = statusFor(pos.healthFactor);
  const block = creditBlockOf({ pos, creditUsd, overFree, after, line, maxUsd, cash: p.cash });

  return {
    creditRaw: p.creditRaw,
    backing: chosen.map((c) => ({ stock: c.option.stock, raw: c.raw, usd: c.usd })),
    limit,
    before,
    after,
    hfAfter: calc.hfAfter,
    // D2's tick is for ending in Watch. Ending in Act is the "act" block above under ACT_LINE; once the line allows it,
    // the same tick, which the screen words as the Wall's rule (intoAct).
    extraConfirm: creditUsd > 0 && (needsExtraConfirm(after) || (line.intoAct && endsInAct(after))),
    intoAct: creditUsd > 0 && line.intoAct && endsInAct(after),
    floor: creditFloor(line),
    maxSafeUsd,
    maxUsd,
    priceMayMove: !marketState(p.now).open,
    block,
  };
}

/** Whether the cash can pay the smallest buy, the fuel tank kept back. */
export const canBuyWithCash = (cash: Cash) => toUsd(maxSpendRaw(cash)) >= BUY_LIMITS.minUsd;

export type CreditAvailable = {
  /** The most one Credit Buy can use right now; 0 with `why`. */
  usd: number;
  why?: NoCredit;
  /** The plain line under the number. */
  line: string;
};

/**
 * The most one Credit Buy can use right now, with the best holding all in use (Invest's buying power), and whether it
 * can use anything at all (Credit Buy's step 1 says why at $0). A Credit Buy is backed by one free holding plus what
 * already backs credit, so this is the best of the per-holding figures (bestBacking, the one step 1 picks first), or
 * the credit left on what already backs credit when nothing free can back it. Each is creditCap: net of what's owed, within
 * what Aave can lend, and never past the Act line's margin, so this figure, step 2's and step 4's MAX and "Up to" are
 * the same number. Under the minimum buy, while new credit is paused, or while the credit is in Act, it is $0 with the
 * reason. With credit but less cash than the network fee, the number stays and the line asks for the fee first.
 * `options` are the ones step 1 lists; `holdsStock` is whether the account owns any stock, free or in use.
 */
export function creditAvailable(p: {
  position: CreditPosition;
  options: readonly BackingOption[];
  cash: Cash;
  holdsStock: boolean;
}): CreditAvailable {
  // The most one Credit Buy can use (boards 30–34): Credit ready, or the stock that backs the most on its own.
  const usd = Math.max(creditWith(p.position), ...p.options.map((o) => ownCreditUsd(p.position, o)));
  const why = ((): NoCredit | undefined => {
    if (!p.holdsStock) return "no-stocks";
    if (p.position.creditPaused) return "paused";
    if (pastStop(p.position.healthFactor, lineOf(p.position)))
      return lineOf(p.position).intoAct ? "past-limit" : "in-act";
    if (usd >= BUY_LIMITS.minUsd) return undefined;
    if (p.position.usdcLiquidity < BUY_LIMITS.minUsd) return "no-liquidity";
    // Nothing backs credit yet: free stock too small to give the $1 minimum buy isn't "all in use".
    if (p.position.totalBackingUsd <= 0) return p.options.length === 0 ? "cant-back" : "too-small";
    return "all-in-use";
  })();
  if (why) return { usd: 0, why, line: noCreditLine(why, canBuyWithCash(p.cash)) };
  return { usd, line: creditLine(p.cash) };
}

/** Why a Credit Buy on screen can't be signed: a block (ending in Act is one), or a Watch ending without the extra confirmation (D2). */
export function creditBuyStop(plan: CreditPlan, confirmedRisk: boolean): string | null {
  if (plan.block) return CREDIT_BLOCKED[plan.block];
  if (plan.extraConfirm && !confirmedRisk)
    return `Confirm you understand this puts your credit in ${STATUS_LABEL[plan.after]} first.`;
  return null;
}

/** What Activity shows while it confirms: the backing put in use, the credit taken and the buy. */
export function creditBuyActivity(p: { stock: ReserveAsset; quote: BuyQuote; plan: CreditPlan }): ActivityItem[] {
  return [
    ...p.plan.backing.map((b) => ({
      kind: "supply" as const,
      symbol: b.stock.symbol,
      amount: Number(b.raw) / 10 ** b.stock.decimals,
    })),
    { kind: "borrow", symbol: USDC.symbol, amount: toUsd(p.plan.creditRaw) },
    {
      kind: "buy",
      symbol: p.stock.symbol,
      amount: Number(p.quote.amountOut) / 10 ** p.stock.decimals,
      paidUsd: toUsd(p.quote.amountIn),
    },
  ];
}

/**
 * Decision 1 ("That's more than your cash"): cash pays what it can, all of it less the network-fee
 * buffer, and credit covers the other part. `creditRaw` is 0 when cash covers the buy.
 */
export function splitCash(amountRaw: bigint, cash: Cash): { cashRaw: bigint; creditRaw: bigint } {
  const max = maxSpendRaw(cash);
  const fromCash = amountRaw < max ? amountRaw : max;
  return { cashRaw: fromCash, creditRaw: amountRaw - fromCash };
}

/**
 * Credit Buy in one batch (plan item 3): [savings withdrawal] → [put backing in use] → take credit
 * → approve → swap, so the credit never sits in the wallet. The swap spends the credit plus what cash
 * pays (decision 1; 0 for a plain Credit Buy). Cash pays the network fee, from savings when the wallet
 * can't (payFromCash). Every call passes the allowlist with the user pinned, and the whole batch is
 * checked against the screen (assertCreditBuy).
 */
export function buildCreditBuyCalls(p: {
  user: Address;
  stock: ReserveAsset;
  quote: BuyQuote;
  /** Aave's price for `stock`, for the buy's floor (buyMinOut). */
  oraclePriceUsd: number;
  creditRaw: bigint;
  /** Exactly what goes in use (the plan's backing: the typed amount on Credit Buy, autoFill's for decision 1). */
  backing: Backing[];
  /** The plan's limit: the free shares it read and the most credit that backing allows. */
  limit: CreditLimit;
  cash: Cash;
  nowSec?: number;
}): Call[] {
  const fromCash = p.quote.amountIn - p.creditRaw;
  if (p.creditRaw <= 0n || fromCash < 0n) throw new Error("Credit must be part of the buy");
  const spend = [
    ...buildBackAndCreditCalls({ user: p.user, backing: p.backing, creditRaw: p.creditRaw }),
    ...buildBuyCalls(p),
  ];
  return assertCreditBuy(p.user, payFromCash(p.user, fromCash, p.cash, spend), {
    stock: p.stock,
    creditRaw: p.creditRaw,
    cashRaw: fromCash,
    backing: p.backing.filter((b) => b.raw > 0n),
    limit: p.limit,
  });
}

const decodeApprove = (c: Call) => {
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
    return d.functionName === "approve" ? d.args : null;
  } catch {
    return null;
  }
};

const spokeCall = (c: Call) => {
  if (!isAddressEqual(c.to, AAVE.SPOKE)) return null;
  try {
    return decodeFunctionData({ abi: spokeAbi, data: c.data });
  } catch {
    return null;
  }
};

/**
 * The Credit Buy checks on the finished batch, against what the screen shows: the stock put in use is exactly
 * `backing`, each for the user, approved exactly to the spoke, never more than its free shares and before the credit;
 * credit is taken once, as USDC to the user, for exactly `creditRaw` and no more than that backing allows; the batch
 * ends with an exact approve and one swap into `stock` (one of the 7), paid to the user, spending exactly the credit
 * plus `cashRaw`.
 */
export function assertCreditBuy(
  user: Address,
  calls: Call[],
  review: { stock: ReserveAsset; creditRaw: bigint; cashRaw: bigint; backing: readonly Backing[]; limit: CreditLimit },
): Call[] {
  const creditCalls = calls.flatMap((c, i) => {
    const d = spokeCall(c);
    return d?.functionName === "borrow" ? [{ i, args: d.args }] : [];
  });
  const supplies = calls.flatMap((c, i) => {
    const d = spokeCall(c);
    return d?.functionName === "supply" ? [{ i, args: d.args }] : [];
  });
  const swaps = calls.flatMap((c, i) => {
    const s = swapOf(c);
    return s ? [{ i, ...s }] : [];
  });
  if (creditCalls.length !== 1 || swaps.length !== 1)
    throw new Error("Blocked: a Credit Buy takes credit once and swaps once");
  const [creditCall] = creditCalls;
  const [swap] = swaps;
  if (swap.i !== calls.length - 1 || creditCall.i > swap.i)
    throw new Error("Blocked: the swap must come last, after the credit");
  const [reserveId, amount, onBehalfOf] = creditCall.args;
  if (reserveId !== BigInt(USDC.reserveId) || amount !== review.creditRaw || !isAddressEqual(onBehalfOf, user)) {
    throw new Error("Blocked: the credit differs from the review");
  }
  if (review.creditRaw > review.limit.maxCreditRaw) throw new Error("Blocked: more credit than the backing allows");

  if (supplies.length !== review.backing.length) throw new Error("Blocked: the backing differs from the review");
  review.backing.forEach((b, n) => {
    const s = supplies[n];
    const [id, raw, onBehalf] = s.args;
    const free = review.limit.freeRaw[b.stock.symbol];
    if (id !== BigInt(b.stock.reserveId) || raw !== b.raw || !isAddressEqual(onBehalf, user) || s.i > creditCall.i) {
      throw new Error("Blocked: the backing differs from the review");
    }
    if (free === undefined || b.raw > free) throw new Error("Blocked: more backing than the free shares");
    const approve = calls[s.i - 1];
    const a = approve && isAddressEqual(approve.to, b.stock.address) ? decodeApprove(approve) : null;
    if (!a || !isAddressEqual(a[0], AAVE.SPOKE) || a[1] !== b.raw)
      throw new Error("Blocked: the backing's approval differs");
  });

  const { tokenIn, tokenOut, recipient, amountIn } = swap.params;
  const isStock = EQUITIES.some((e) => isAddressEqual(e.address, tokenOut));
  if (
    !isStock ||
    !isAddressEqual(tokenOut, review.stock.address) ||
    !isAddressEqual(tokenIn, USDC.address) ||
    !isAddressEqual(recipient, user) ||
    amountIn !== review.creditRaw + review.cashRaw
  ) {
    throw new Error("Blocked: the swap differs from the review");
  }
  const approve = calls[swap.i - 1];
  const a = approve && isAddressEqual(approve.to, USDC.address) ? decodeApprove(approve) : null;
  if (!a || !isAddressEqual(a[0], swap.router) || a[1] !== amountIn) {
    throw new Error("Blocked: the approval differs from the swap");
  }
  return calls;
}

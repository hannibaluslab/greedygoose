/**
 * Protect · sell: when cash can't bring the credit out of Act, sell some of the stock that backs it and repay with the
 * proceeds, back to Watch (plan item 1, steps 10–12; Act is the line, 2026-10-15). Integer on-chain units only, so GooseExecutor's port
 * (contracts/src/SellRules.sol) must agree exactly: test/SellRules.t.sol runs both on the vectors from
 * scripts/agent-vectors.ts.
 *
 * Units: Aave Value (1e26 = $1), WAD (1e18), prices with 8 decimals, shares with 8, USDC units with 6, collateral
 * factors in BPS. A holding is worth shares × price × 1e10 Value, and backs cf × that.
 */

/** One stock, by reserve id. */
export type SellHolding = {
  /** Raw shares backing the credit; 0 when it doesn't (or only with a collateral factor of 0). */
  sharesRaw: bigint;
  /** Aave's oracle price, 8 decimals. */
  price: bigint;
  /** Collateral factor in BPS, from the reserve's current config: a withdrawal applies it to the whole position. */
  cfBps: bigint;
  /** Raw shares today's limit still allows. 0 = not for sale: never-sell, limit used up or reserve paused. */
  limitRaw: bigint;
  /** USDC units, at Aave's price, that the pool's window still allows across all accounts. */
  poolLeftRaw: bigint;
};

export type SellBook = {
  /** The seven stocks, by reserve id. */
  stocks: readonly SellHolding[];
  /** What the account owes, in Value, rounded up. */
  debtValue: bigint;
  /** USDC's oracle price, 8 decimals: a repay of 1 unit lowers the debt by usdcPrice × 1e12 Value. */
  usdcPrice: bigint;
  /** USDC units today's limit still allows: the repay leg's limit. */
  usdcLeftRaw: bigint;
};

type SellOptions = {
  targetHf: bigint;
  floorBps: bigint;
  /** "Keep my mix": the same % of each holding, instead of the most safety per dollar first. */
  keepMix: boolean;
};

/** One withdraw → swap → repay step of the batch. */
type SellSlice = { reserveId: number; sharesRaw: bigint; minOutRaw: bigint };

export const SELL_RULE = {
  /** Collateral factors within one point of each other are a near-tie: the larger holding goes first. */
  tieBps: 100n,
  /** Aave's spoke checks health ≥ 1.0 right after each withdrawal; a slice keeps it at least this high. */
  withdrawFloorHf: 1_001n * 10n ** 15n,
  /** Most slices in one run (one batch, within its gas cap). The rest waits for the next run. */
  maxSlices: 6,
} as const;

const WAD = 10n ** 18n;
const BPS = 10_000n;
const min = (...v: bigint[]) => v.reduce((a, b) => (b < a ? b : a));
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

/** Value of `shares` at `price`. */
const value = (shares: bigint, price: bigint) => shares * price * 10n ** 10n;

/** Sell order: lowest collateral factor first (the most safety per dollar sold), near-ties to the larger holding. */
export function sellOrder(stocks: readonly SellHolding[]): number[] {
  const order = stocks.map((_, i) => i);
  const before = (a: SellHolding, b: SellHolding) => {
    const gap = a.cfBps > b.cfBps ? a.cfBps - b.cfBps : b.cfBps - a.cfBps;
    if (gap <= SELL_RULE.tieBps) return a.sharesRaw * a.price > b.sharesRaw * b.price;
    return a.cfBps < b.cfBps;
  };
  for (let i = 1; i < order.length; i++) {
    for (let j = i; j > 0 && before(stocks[order[j]], stocks[order[j - 1]]); j--) {
      [order[j], order[j - 1]] = [order[j - 1], order[j]];
    }
  }
  return order;
}

/** Backing power: Σ cf × value, in BPS · Value. Health = power × 1e14 / debt. */
export function sellPower(stocks: readonly SellHolding[]): bigint {
  return stocks.reduce((p, s) => p + s.cfBps * value(s.sharesRaw, s.price), 0n);
}

/**
 * The least stock to sell, per reserve id in raw shares, for the health to reach `targetHf` once the proceeds repay
 * at the floor. Each stock is held to its backing, its daily limit, its pool's window and the USDC limit; what one
 * can't cover spills over to the next in `sellOrder`.
 */
export function sellAmounts(book: SellBook, o: SellOptions): bigint[] {
  const take = book.stocks.map(() => 0n);
  const have = sellPower(book.stocks) * 10n ** 14n;
  const need = o.targetHf * book.debtValue;
  if (need <= have) return take;
  // Each slice's minimum output rounds down by under a unit of USDC: the slack covers every slice of the run.
  let deficit = need - have + o.targetHf * book.usdcPrice * 10n ** 12n * BigInt(SELL_RULE.maxSlices);
  let usdcLeft = book.usdcLeftRaw;
  const poolLeft = book.stocks.map((s) => s.poolLeftRaw);
  const keep = BPS - o.floorBps;
  // Health gained per raw share sold, × debt: the repay's weight at the target minus the backing given up.
  const gainPer = book.stocks.map((s) => {
    const repay = (o.targetHf * keep * book.usdcPrice) / 100n;
    const lost = s.cfBps * 10n ** 24n;
    return s.sharesRaw > 0n && s.limitRaw > 0n && s.cfBps > 0n && repay > lost ? s.price * (repay - lost) : 0n;
  });
  const sell = (i: number, want: bigint) => {
    const s = book.stocks[i];
    const n = min(
      want,
      s.sharesRaw - take[i],
      s.limitRaw - take[i],
      (poolLeft[i] * 10n ** 10n) / s.price,
      (usdcLeft * 10n ** 14n) / (s.price * keep),
    );
    if (n === 0n) return;
    take[i] += n;
    poolLeft[i] -= ceilDiv(n * s.price, 10n ** 10n);
    usdcLeft -= ceilDiv(n * s.price * keep, 10n ** 14n);
    const gain = gainPer[i] * n;
    deficit = gain >= deficit ? 0n : deficit - gain;
  };

  const order = sellOrder(book.stocks).filter((i) => gainPer[i] > 0n);
  if (o.keepMix) {
    const total = order.reduce((t, i) => t + gainPer[i] * book.stocks[i].sharesRaw, 0n);
    // The share of every holding to sell, WAD: at most all of it.
    const q = total > 0n ? min(ceilDiv(deficit * WAD, total), WAD) : 0n;
    for (const i of order) {
      if (deficit === 0n) break;
      sell(i, ceilDiv(q * book.stocks[i].sharesRaw, WAD));
    }
  }
  for (const i of order) {
    if (deficit === 0n) break;
    sell(i, ceilDiv(deficit, gainPer[i]));
  }
  return take;
}

/**
 * Splits the amounts into withdraw → swap → repay slices, in `sellOrder`. Each withdrawal leaves the health at least
 * `withdrawFloorHf` (Aave reverts a withdrawal that leaves it under 1.0), each swap stays within `maxSliceRaw` USDC
 * at Aave's price, and each repays exactly its minimum output. Stops at `maxSlices`, or when Aave's floor leaves no
 * room: the rest waits for the next run.
 */
export function sellSlices(
  book: SellBook,
  take: readonly bigint[],
  o: { floorBps: bigint; maxSliceRaw: bigint },
): SellSlice[] {
  const slices: SellSlice[] = [];
  let power = sellPower(book.stocks);
  let debt = book.debtValue;
  const floor = SELL_RULE.withdrawFloorHf;
  for (const i of sellOrder(book.stocks)) {
    const s = book.stocks[i];
    let left = take[i];
    while (left > 0n) {
      if (slices.length === SELL_RULE.maxSlices) return slices;
      const room =
        power * 10n ** 14n > floor * debt ? (power * 10n ** 14n - floor * debt) / (s.cfBps * s.price * 10n ** 24n) : 0n;
      const shares = min(left, room, (o.maxSliceRaw * 10n ** 10n) / s.price);
      const minOut = (shares * s.price * (BPS - o.floorBps)) / 10n ** 14n;
      if (minOut === 0n) return slices;
      slices.push({ reserveId: i, sharesRaw: shares, minOutRaw: minOut });
      power -= s.cfBps * value(shares, s.price);
      const repaid = minOut * book.usdcPrice * 10n ** 12n;
      debt = repaid >= debt ? 0n : debt - repaid;
      left -= shares;
    }
  }
  return slices;
}

/** The sale for one run: its slices and what they repay in total, in USDC units. */
export function planSell(
  book: SellBook,
  o: SellOptions & { maxSliceRaw: bigint },
): { slices: SellSlice[]; repayRaw: bigint } {
  const slices = sellSlices(book, sellAmounts(book, o), o);
  return { slices, repayRaw: slices.reduce((t, s) => t + s.minOutRaw, 0n) };
}

type SellTiming = "wait" | "heads-up" | "clear" | "sell";

/**
 * When Protect sells (decision 3, Act is the line, 2026-10-15): below `headsUpHf` (the Act line) on a weekday, a
 * heads-up, then the sale `headsUpDelaySec` later if the health is still below; below `nowHf`, deep in Act, at once.
 * Never in Safe or Watch, and never while prices are held (weekends and holidays). Back above `headsUpHf`, a pending
 * heads-up is cleared, so a later fall gets a new one. `headsUpAt` is 0 when none is pending. A sale below `nowHf`
 * uses the wider Act floor.
 */
export function sellTiming(
  hf: bigint,
  headsUpAt: bigint,
  nowSec: bigint,
  frozen: boolean,
  l: { headsUpHf: bigint; nowHf: bigint; headsUpDelaySec: bigint },
): { timing: SellTiming; atOnce: boolean } {
  if (hf >= l.headsUpHf) return { timing: headsUpAt !== 0n ? "clear" : "wait", atOnce: false };
  if (frozen) return { timing: "wait", atOnce: false };
  if (hf < l.nowHf) return { timing: "sell", atOnce: true };
  if (headsUpAt === 0n) return { timing: "heads-up", atOnce: false };
  return { timing: nowSec >= headsUpAt + l.headsUpDelaySec ? "sell" : "wait", atOnce: false };
}

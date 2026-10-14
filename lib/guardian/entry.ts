/**
 * The Entry agent on Base (plan item 2, steps 1-3): a whitelisted dollar stablecoin that lands in the wallet becomes
 * USDC in the same wallet, at 99.5% of its face value or better, one capped swap a run. Then the Cash Agent takes
 * over. Integer on-chain units only, so GooseExecutor's port (contracts/src/EntryRules.sol) must agree exactly:
 * test/EntryRules.t.sol runs both on the vectors from scripts/agent-vectors.ts.
 */

/** One whitelisted coin, in the order of ENTRY_COINS (lib/tokens/stables.ts). */
export type EntryCoin = {
  /** Raw units in the wallet. */
  balanceRaw: bigint;
  decimals: number;
  /** Raw units today's limit for this coin still allows. */
  limitLeftRaw: bigint;
  /** Its last swap couldn't meet the floor, and the retry time hasn't come. */
  waiting: boolean;
};

export type EntryOptions = {
  /** Each swap gets at least face value less this. */
  floorBps: bigint;
  /** Smallest swap worth making, USDC units of face value. */
  minEntryRaw: bigint;
  /** Largest swap, USDC units of face value: a larger balance is split over the next runs. */
  maxSwapRaw: bigint;
};

/** The swap for one run: `amountIn` raw units of coin `index` for at least `minOut` USDC units. */
export type EntryMove = { index: number; amountIn: bigint; minOut: bigint };

const BPS = 10_000n;
const USDC_DECIMALS = 6;
const min = (...v: bigint[]) => v.reduce((a, b) => (b < a ? b : a));
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

/**
 * The first coin, in whitelist order, worth converting now: not waiting, and at least `minEntryRaw` of face value
 * within its daily limit. It swaps all of it, up to `maxSwapRaw`; the rest goes in the next runs.
 */
export function planEntry(coins: readonly EntryCoin[], o: EntryOptions): EntryMove | null {
  for (let i = 0; i < coins.length; i++) {
    const c = coins[i];
    if (c.waiting) continue;
    const scale = 10n ** BigInt(c.decimals - USDC_DECIMALS);
    const amountIn = min(c.balanceRaw, c.limitLeftRaw, o.maxSwapRaw * scale);
    if (amountIn / scale < o.minEntryRaw) continue;
    return { index: i, amountIn, minOut: ceilDiv(amountIn * (BPS - o.floorBps), BPS * scale) };
  }
  return null;
}

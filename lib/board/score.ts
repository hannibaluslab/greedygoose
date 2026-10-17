/**
 * The leaderboard's one number: return since joining, in percent (Adrian, 2026-10-15). Pure, so the board, its tests
 * and later Home's all-time return can share it.
 *
 *   net worth = cash (wallet USDC and savings) + other dollars at face value + stocks at Aave's price, including the
 *               stocks backing credit, − credit owed
 *   gain      = net worth now + money taken out since joining − money put in since joining − net worth at joining
 *   own money = net worth at joining + money put in since
 *   return    = gain ÷ own money (Adrian, 2026-10-17: gains count on own money, so winning with credit lifts the rank)
 *
 * Money moving in or out (deposits, withdrawals, payments between members) moves net worth and the flows by the same
 * amount, so it never counts as gain. Fees and interest lower net worth and nothing else, so they lower the return; a
 * liquidation's penalty does too. Credit counts both ways, over own money: a stock bought with it lifts the return when
 * it rises and deepens it when it falls. A member with no own money yet isn't ranked; there is no other minimum.
 */

/** Dollars, read from the chain at the member's join block and now (lib/board/read.ts). */
export type Flows = {
  /** Net worth at the end of the member's join block. */
  worthAtJoin: number;
  /** Net worth now. */
  worthNow: number;
  /** Money that came into the account from outside since joining, valued when it arrived. */
  putIn: number;
  /** Money that left the account for outside since joining, valued when it left (fees aren't money taken out). */
  takenOut: number;
  /** The most credit in use at once since joining (including at joining and now). Read for the leverage, not the score. */
  peakCredit: number;
};

type Score = {
  /** Dollars gained since joining. Never shown: the board is percent only. */
  gain: number;
  /** Own money: net worth at joining plus money put in since. */
  own: number;
  /** The return as a fraction (0.05 = +5%), or null when the member isn't ranked yet (no own money). */
  pct: number | null;
};

export function returnSinceJoining(f: Flows): Score {
  const gain = f.worthNow + f.takenOut - f.putIn - f.worthAtJoin;
  const own = f.worthAtJoin + f.putIn;
  if (!(own > 0) || !Number.isFinite(gain)) return { gain, own, pct: null };
  return { gain, own, pct: gain / own };
}

type RankInput = { account: `0x${string}`; joinedAt: bigint; pct: number | null };

/**
 * Ranks members with a return, highest first; ties go to whoever joined first, then by address so the order is the
 * same on every phone. Members without one (not ranked yet) come after, in the order they joined, with no rank.
 */
export function rankRows<T extends RankInput>(rows: readonly T[]): (T & { rank: number | null })[] {
  const ranked = rows
    .filter((r) => r.pct !== null)
    .sort(
      (a, b) =>
        b.pct! - a.pct! ||
        cmpBig(a.joinedAt, b.joinedAt) ||
        a.account.toLowerCase().localeCompare(b.account.toLowerCase()),
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const rest = rows
    .filter((r) => r.pct === null)
    .sort((a, b) => cmpBig(a.joinedAt, b.joinedAt) || a.account.toLowerCase().localeCompare(b.account.toLowerCase()))
    .map((r) => ({ ...r, rank: null }));
  return [...ranked, ...rest];
}

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

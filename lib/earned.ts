import { decodeEventLog, parseAbi, type Hex } from "viem";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

/**
 * What the cash has earned in savings, on Aave V3's own numbers. aUSDC emits Mint (to `onBehalfOf`) or Burn (from
 * `from`) on every move of an account's savings, and its `balanceIncrease` is the interest earned since that account's
 * previous move; the pool's Supply and Withdraw in the same receipt say what went in or came out. So each move closes a
 * stretch at one balance, and the total is those stretches' interest plus what has built up since the last move: the
 * balance now less the balance at the index of that move.
 */
export const aUsdcEarnAbi = parseAbi([
  "function scaledBalanceOf(address) view returns (uint256)",
  "function getPreviousIndex(address) view returns (uint256)",
]);

const moveEvents = parseAbi([
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 value, uint256 balanceIncrease, uint256 index)",
  "event Burn(address indexed from, address indexed target, uint256 value, uint256 balanceIncrease, uint256 index)",
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
]);

const RAY = 10n ** 27n;
const is = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type LogLike = { address: string; data: Hex; topics: readonly Hex[] };

/**
 * One batch's savings move for `who`: the interest it closed (each aUSDC Mint or Burn of theirs, `balanceIncrease`)
 * and what went in less what came out (the pool's USDC Supply for them, Withdraw by them).
 */
export function moveIn(logs: readonly LogLike[], who: string): { inc: bigint; net: bigint } {
  let inc = 0n;
  let net = 0n;
  for (const l of logs) {
    const aToken = is(l.address, PROTOCOLS.AUSDC);
    if (!aToken && !is(l.address, PROTOCOLS.AAVE_V3_POOL)) continue;
    try {
      const e = decodeEventLog({ abi: moveEvents, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (aToken && e.eventName === "Mint" && e.args && is(e.args.onBehalfOf, who)) inc += e.args.balanceIncrease;
      if (aToken && e.eventName === "Burn" && e.args && is(e.args.from, who)) inc += e.args.balanceIncrease;
      if (
        !aToken &&
        e.eventName === "Supply" &&
        e.args &&
        is(e.args.reserve, USDC.address) &&
        is(e.args.onBehalfOf, who)
      )
        net += e.args.amount;
      if (!aToken && e.eventName === "Withdraw" && e.args && is(e.args.reserve, USDC.address) && is(e.args.user, who))
        net -= e.args.amount;
    } catch {
      // Not one of these four (a Transfer, an Approval): nothing for the savings.
    }
  }
  return { inc, net };
}

/** Interest built up since the account's last move: the balance now less the balance at that move's index. */
export function sinceLastMoveRaw(balanceRaw: bigint, scaledRaw: bigint, previousIndex: bigint): bigint {
  const atMove = (scaledRaw * previousIndex + RAY / 2n) / RAY;
  return balanceRaw > atMove ? balanceRaw - atMove : 0n;
}

/** A savings move, in dollars: when (unix seconds), the interest it closed, and what went in less what came out. */
export type SavingsMove = { t: number; inc: number; net: number };

type EarnedPeriod = {
  /** Interest earned in the period. */
  earnedUsd: number;
  /** The savings balance, averaged over the period's time. */
  heldUsd: number;
  /** How long the period is: from its start, or the first move into savings if later, to now. */
  days: number;
  /** When it starts (unix seconds), or null when nothing was ever saved. */
  fromSec: number | null;
};

/**
 * What the savings earned since `sinceSec` (null: all time) and what they held on average, from the moves in time order
 * and the interest built up since the last of them (`openInc`, up to `nowSec`). Between two moves the balance holds
 * still and its interest comes in evenly, so a stretch the period cuts counts its share by time.
 */
export function earnedPeriod(
  moves: readonly SavingsMove[],
  openInc: number,
  nowSec: number,
  sinceSec: number | null,
): EarnedPeriod {
  const first = moves.find((m) => m.net > 0);
  if (!first) return { earnedUsd: 0, heldUsd: 0, days: 0, fromSec: null };
  const from = Math.max(sinceSec ?? first.t, first.t);
  const span = Math.max(0, nowSec - from);
  let earned = 0;
  let heldTime = 0;
  let balance = 0;
  let at = moves[0].t;
  const stretch = (start: number, end: number, bal: number, inc: number) => {
    const len = end - start;
    const overlap = Math.max(0, Math.min(end, nowSec) - Math.max(start, from));
    earned += len > 0 ? (inc * overlap) / len : end >= from ? inc : 0;
    heldTime += bal * overlap;
  };
  for (const m of moves) {
    stretch(at, m.t, balance, m.inc);
    balance = Math.max(0, balance + m.inc + m.net);
    at = m.t;
  }
  stretch(at, nowSec, balance, openInc);
  return { earnedUsd: earned, heldUsd: span > 0 ? heldTime / span : balance, days: span / 86_400, fromSec: from };
}

/**
 * The yearly rate a period really earned (the Yield sheet's Average yield, Adrian 2026-10-21): what it earned over what
 * it held on average, compounded over a year as Aave's APY is, so it reads beside the cash rate. Null under a day (too
 * short to say), or with nothing held.
 */
export function averageYield(p: EarnedPeriod): number | null {
  if (p.fromSec === null || p.days < 1 || p.heldUsd <= 0) return null;
  return (1 + p.earnedUsd / p.heldUsd) ** (365 / p.days) - 1;
}

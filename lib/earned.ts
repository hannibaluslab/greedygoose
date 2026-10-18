import { decodeEventLog, parseAbi, type Hex } from "viem";
import { PROTOCOLS } from "@/lib/protocols/config";

/**
 * What the cash has earned in savings, all time, on Aave V3's own numbers. aUSDC emits Mint (to `onBehalfOf`) or Burn
 * (from `from`) on every move of an account's savings, and its `balanceIncrease` is the interest earned since that
 * account's previous move. So the total is those, summed over the account's batches, plus what has built up since the
 * last move: the balance now less the balance at the index of that move.
 */
export const aUsdcEarnAbi = parseAbi([
  "function scaledBalanceOf(address) view returns (uint256)",
  "function getPreviousIndex(address) view returns (uint256)",
]);

const moveEvents = parseAbi([
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 value, uint256 balanceIncrease, uint256 index)",
  "event Burn(address indexed from, address indexed target, uint256 value, uint256 balanceIncrease, uint256 index)",
]);

const RAY = 10n ** 27n;

/** The interest one batch's logs closed for `who`: the `balanceIncrease` of each aUSDC Mint or Burn of theirs. */
export function interestIn(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[],
  who: string,
): bigint {
  const me = who.toLowerCase();
  let sum = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== PROTOCOLS.AUSDC.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi: moveEvents, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (e.eventName === "Mint" && e.args?.onBehalfOf.toLowerCase() === me) sum += e.args.balanceIncrease;
      if (e.eventName === "Burn" && e.args?.from.toLowerCase() === me) sum += e.args.balanceIncrease;
    } catch {
      // Not a Mint or Burn (a Transfer, an Approval): no interest in it.
    }
  }
  return sum;
}

/** Interest built up since the account's last move: the balance now less the balance at that move's index. */
export function sinceLastMoveRaw(balanceRaw: bigint, scaledRaw: bigint, previousIndex: bigint): bigint {
  const atMove = (scaledRaw * previousIndex + RAY / 2n) / RAY;
  return balanceRaw > atMove ? balanceRaw - atMove : 0n;
}

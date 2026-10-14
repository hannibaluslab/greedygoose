import { decodeErrorResult, isAddressEqual, type Hex } from "viem";
import { spokeAbi } from "./abis/ISpoke";
import { hubAbi } from "./abis/IHub";
import { GUARDIAN, SEL } from "@/lib/guardian/config";
import { BUY_LIMITS } from "@/lib/swap/buy";
import { ROUTERS } from "@/lib/swap/venues";

const PLAIN: Record<string, string> = {
  HealthFactorBelowThreshold: "This would put your loan past what Aave allows. Try a smaller amount.",
  ReservePaused: "Aave has paused this market for now. Try again later.",
  ReserveFrozen: "Aave isn’t accepting new activity in this market right now.",
  ReserveNotBorrowable: "Aave isn’t giving new USDC credit right now.",
  ReserveNotEnabledAsCollateral: "This stock isn’t being used as collateral yet.",
  InsufficientLiquidity: "Aave doesn’t have enough USDC to lend right now. Try a smaller amount.",
  MustNotLeaveDust: "That would leave a tiny amount behind. Repay all, or a little less.",
  MaximumUserReservesExceeded: "You’ve reached Aave’s limit on how many markets one account can use.",
};

/**
 * A savings withdrawal (Aave V3 Pool.withdraw) reverts when the pool is short of free USDC, is paused,
 * or the savings balance read is stale (NotEnoughAvailableUserBalance). Each time, the cash can't come out now.
 */
export const CASH_STUCK = "Cash can’t be moved right now. Try again soon, or use credit.";

const isSavingsWithdrawal = (call: { to: `0x${string}`; data: Hex }) =>
  isAddressEqual(call.to, GUARDIAN.AAVE_V3_POOL) && call.data.slice(0, 10) === SEL.withdraw;

/**
 * Swap router reverts, the same strings on Uniswap's SwapRouter02 and Aerodrome's Slipstream router
 * (simulated on Base 2026-10-14). Aerodrome's expired deadline reverts with no data, so it reads as the fallback.
 */
const ROUTER_PLAIN: Record<string, string> = {
  "Too little received": `The price moved more than ${BUY_LIMITS.slippageBps / 100}% since your quote. Check the new price and try again.`,
  "Transaction too old": "This took too long to go through. Try again.",
  STF: "Your cash moved since you started. Check the amount and try again.",
};

const isSwap = (call: { to: `0x${string}` }) => ROUTERS.some((r) => isAddressEqual(r, call.to));

/** Turn a revert into consumer language (CLAUDE.md › Error handling). `call` is the call that reverted. */
export function explainRevert(data: Hex | undefined, fallback: string, call?: { to: `0x${string}`; data: Hex }): string {
  if (call && isSavingsWithdrawal(call)) return CASH_STUCK;
  if (!data || data === "0x") return fallback;
  if (call && isSwap(call)) {
    try {
      const { errorName, args } = decodeErrorResult({ abi: [], data });
      return (errorName === "Error" && ROUTER_PLAIN[args[0] as string]) || fallback;
    } catch {
      return fallback;
    }
  }
  for (const abi of [spokeAbi, hubAbi]) {
    try {
      const { errorName } = decodeErrorResult({ abi, data });
      return PLAIN[errorName] ?? fallback;
    } catch {
      /* not this ABI */
    }
  }
  return fallback;
}

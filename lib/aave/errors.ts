import { decodeErrorResult, isAddressEqual, type Hex } from "viem";
import { spokeAbi } from "./abis/ISpoke";
import { hubAbi } from "./abis/IHub";
import { GUARDIAN, SEL } from "@/lib/guardian/config";

const PLAIN: Record<string, string> = {
  HealthFactorBelowThreshold: "This would put your loan past what Aave allows. Try a smaller amount.",
  ReservePaused: "Aave has paused this market for now. Try again later.",
  ReserveFrozen: "Aave isn’t accepting new activity in this market right now.",
  ReserveNotBorrowable: "Borrowing USDC is switched off on Aave right now.",
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

/** Turn a revert into consumer language (CLAUDE.md › Error handling). `call` is the call that reverted. */
export function explainRevert(data: Hex | undefined, fallback: string, call?: { to: `0x${string}`; data: Hex }): string {
  if (call && isSavingsWithdrawal(call)) return CASH_STUCK;
  if (!data || data === "0x") return fallback;
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

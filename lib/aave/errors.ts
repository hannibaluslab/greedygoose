import { decodeErrorResult, type Hex } from "viem";
import { spokeAbi } from "./abis/ISpoke";
import { hubAbi } from "./abis/IHub";

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

/** Turn a revert into consumer language (CLAUDE.md › Error handling). */
export function explainRevert(data: Hex | undefined, fallback: string): string {
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

import { decodeErrorResult, isAddressEqual, type Hex } from "viem";
import { spokeAbi } from "./abis/ISpoke";
import { hubAbi } from "./abis/IHub";
import { swapOf } from "@/lib/allowlist";
import { PROTOCOLS, SEL } from "@/lib/protocols/config";
import { BUY_LIMITS } from "@/lib/swap/buy";
import { AERODROME_V1, ROUTERS, SPARK_PSM3 } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

const PLAIN: Record<string, string> = {
  HealthFactorBelowThreshold: "That’s more than your stocks can back right now. Try a smaller amount.",
  ReservePaused: "Aave has paused this market for now. Try again later.",
  ReserveFrozen: "Aave isn’t accepting new activity in this market right now.",
  ReserveNotBorrowable: "Aave isn’t giving new USDC credit right now.",
  ReserveNotEnabledAsCollateral: "This stock doesn’t back your credit yet.",
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
  isAddressEqual(call.to, PROTOCOLS.AAVE_V3_POOL) && call.data.slice(0, 10) === SEL.withdraw;

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

/** STF on a sale: the router couldn't take the stock (what's held moved, or the stock is paused or held by its policy). */
export const stockStf = (name: string) =>
  `${name} couldn’t be sold. What you hold may have changed since you started, or ${name} may be paused for now. Try again in a moment.`;

/**
 * STF is the router failing to take what it sells from the user, so its words follow that token: the cash on a buy, the
 * stock's shares on a sale (a B20 pause or transfer policy reverts this way too). Anything else keeps the fallback.
 */
function stfText(call: { to: `0x${string}`; data: Hex }): string | null {
  const tokenIn = swapOf(call)?.params.tokenIn;
  if (!tokenIn) return null;
  if (isAddressEqual(tokenIn, USDC.address)) return ROUTER_PLAIN.STF;
  const stock = EQUITIES.find((e) => isAddressEqual(e.address, tokenIn));
  return stock ? stockStf(stock.name) : null;
}

/**
 * Other dollars into cash (lib/swap/entry.ts): its floor is face value less 0.5%, not a quote less a buy's slippage, so
 * a revert there keeps the conversion's own words (the caller's fallback).
 */
function isConversion(call: { to: `0x${string}`; data: Hex }): boolean {
  if (isAddressEqual(call.to, AERODROME_V1.ROUTER) || isAddressEqual(call.to, SPARK_PSM3.PSM3)) return true;
  const swap = swapOf(call);
  return !!swap && ENTRY_COINS.some((c) => isAddressEqual(c.address, swap.params.tokenIn));
}

/** Turn a revert into consumer language (CLAUDE.md › Error handling). `call` is the call that reverted. */
export function explainRevert(
  data: Hex | undefined,
  fallback: string,
  call?: { to: `0x${string}`; data: Hex },
): string {
  if (call && isSavingsWithdrawal(call)) return CASH_STUCK;
  if (!data || data === "0x" || (call && isConversion(call))) return fallback;
  if (call && isSwap(call)) {
    try {
      const { errorName, args } = decodeErrorResult({ abi: [], data });
      if (errorName !== "Error") return fallback;
      if (args[0] === "STF") return stfText(call) ?? fallback;
      return ROUTER_PLAIN[args[0] as string] || fallback;
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

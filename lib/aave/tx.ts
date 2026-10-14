import { encodeFunctionData, erc20Abi, maxUint256, type Hex } from "viem";
import { AAVE } from "./addresses";
import { spokeAbi } from "./abis/ISpoke";
import { assertAllowed } from "@/lib/allowlist";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

export type Call = { to: `0x${string}`; data: Hex; value: bigint };

const approve = (token: `0x${string}`, amount: bigint): Call => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, amount] }),
  value: 0n,
});

const spoke = (data: Hex): Call => ({ to: AAVE.SPOKE, data, value: 0n });

/**
 * Supply a stock and make sure it counts as collateral.
 * The Spoke pulls the token from the caller (safeTransferFrom → hub), so the spender is the Spoke.
 * setUsingAsCollateral is a no-op when already enabled.
 */
export function buildSupplyCalls(p: { user: `0x${string}`; stock: ReserveAsset; amountRaw: bigint }): Call[] {
  if (p.stock.kind !== "equity") throw new Error("Not a supported stock");
  if (p.amountRaw <= 0n) throw new Error("Amount must be positive");
  const id = BigInt(p.stock.reserveId);
  return assertAllowed([
    approve(p.stock.address, p.amountRaw),
    spoke(encodeFunctionData({ abi: spokeAbi, functionName: "supply", args: [id, p.amountRaw, p.user] })),
    spoke(encodeFunctionData({ abi: spokeAbi, functionName: "setUsingAsCollateral", args: [id, true, p.user] })),
  ]);
}

/**
 * Withdraw (unlock) a stock back to the user's account. Aave re-checks health on-chain.
 * `all` sends max uint, which the Spoke treats as "withdraw everything supplied".
 */
export function buildWithdrawCalls(p: { user: `0x${string}`; stock: ReserveAsset; amountRaw: bigint; all: boolean }): Call[] {
  if (p.stock.kind !== "equity") throw new Error("Not a supported stock");
  if (!p.all && p.amountRaw <= 0n) throw new Error("Amount must be positive");
  const amount = p.all ? maxUint256 : p.amountRaw;
  return assertAllowed([
    spoke(encodeFunctionData({ abi: spokeAbi, functionName: "withdraw", args: [BigInt(p.stock.reserveId), amount, p.user] })),
  ]);
}

/**
 * Get a loan in one signature: (optionally) lock collateral, then borrow.
 * D7: allowed because the confirm screen lists both steps.
 */
export function buildLoanCalls(p: { user: `0x${string}`; locks: { stock: ReserveAsset; raw: bigint }[]; borrowRaw: bigint }): Call[] {
  const lock = p.locks.filter((l) => l.raw > 0n).flatMap((l) => buildSupplyCalls({ user: p.user, stock: l.stock, amountRaw: l.raw }));
  const borrow = p.borrowRaw > 0n ? buildBorrowCalls({ user: p.user, amountRaw: p.borrowRaw }) : [];
  if (lock.length + borrow.length === 0) throw new Error("Nothing to do");
  return assertAllowed([...lock, ...borrow]);
}

/** Borrow USDC to the caller (the user's own account). */
export function buildBorrowCalls(p: { user: `0x${string}`; amountRaw: bigint }): Call[] {
  if (p.amountRaw <= 0n) throw new Error("Amount must be positive");
  return assertAllowed([
    spoke(encodeFunctionData({ abi: spokeAbi, functionName: "borrow", args: [BigInt(USDC.reserveId), p.amountRaw, p.user] })),
  ]);
}

/**
 * Repay USDC. The Spoke caps the amount at the live debt, so "repay all" sends a small buffer over
 * the debt read (interest accrues every second) and then resets the leftover allowance to 0.
 */
export function buildRepayCalls(p: { user: `0x${string}`; amountRaw: bigint; all: boolean }): Call[] {
  if (p.amountRaw <= 0n) throw new Error("Amount must be positive");
  const calls = [
    approve(USDC.address, p.amountRaw),
    spoke(encodeFunctionData({ abi: spokeAbi, functionName: "repay", args: [BigInt(USDC.reserveId), p.amountRaw, p.user] })),
  ];
  if (p.all) calls.push(approve(USDC.address, 0n));
  return assertAllowed(calls);
}

/** Amount to send for a full repay: debt + 0.05% + 1 unit, never more than the cash can pay (`maxSpendRaw`). */
export function fullRepayAmount(debtRaw: bigint, maxSpendRaw: bigint): bigint {
  const withBuffer = debtRaw + debtRaw / 2000n + 1n;
  return withBuffer < maxSpendRaw ? withBuffer : maxSpendRaw;
}

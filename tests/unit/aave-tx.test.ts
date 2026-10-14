import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, erc20Abi, toFunctionSelector } from "viem";
import { buildBorrowCalls, buildLoanCalls, buildRepayCalls, buildSupplyCalls, fullRepayAmount } from "@/lib/aave/tx";
import { CASH_STUCK, explainRevert } from "@/lib/aave/errors";
import { buildAddSavingsCalls, buildWithdrawSavingsCalls } from "@/lib/guardian/permission";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { AAVE } from "@/lib/aave/addresses";
import { buildBuyCalls } from "@/lib/swap/buy";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user = "0x000000000000000000000000000000000000dEaD";
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

describe("buildSupplyCalls", () => {
  it("approves the spoke, supplies, enables collateral", () => {
    const [a, s, c] = buildSupplyCalls({ user, stock: nvda, amountRaw: 150_000_000n });
    expect(a.to).toBe(nvda.address);
    expect(decodeFunctionData({ abi: erc20Abi, data: a.data }).args).toEqual([AAVE.SPOKE, 150_000_000n]);
    expect(s.to).toBe(AAVE.SPOKE);
    expect(decodeFunctionData({ abi: spokeAbi, data: s.data })).toMatchObject({ functionName: "supply", args: [5n, 150_000_000n, user] });
    expect(decodeFunctionData({ abi: spokeAbi, data: c.data })).toMatchObject({ functionName: "setUsingAsCollateral", args: [5n, true, user] });
  });
  it("rejects USDC and zero", () => {
    expect(() => buildSupplyCalls({ user, stock: USDC, amountRaw: 1n })).toThrow();
    expect(() => buildSupplyCalls({ user, stock: nvda, amountRaw: 0n })).toThrow();
  });
});

describe("buildBorrowCalls", () => {
  it("borrows USDC reserve 7 to the user", () => {
    const [b] = buildBorrowCalls({ user, amountRaw: 25_000_000n });
    expect(decodeFunctionData({ abi: spokeAbi, data: b.data })).toMatchObject({ functionName: "borrow", args: [7n, 25_000_000n, user] });
  });
});

describe("buildRepayCalls", () => {
  it("partial: approve + repay, no reset", () => {
    const calls = buildRepayCalls({ user, amountRaw: 10_000_000n, all: false });
    expect(calls).toHaveLength(2);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[1].data })).toMatchObject({ functionName: "repay", args: [7n, 10_000_000n, user] });
  });
  it("all: resets allowance to 0 afterwards", () => {
    const calls = buildRepayCalls({ user, amountRaw: 10_000_000n, all: true });
    expect(calls).toHaveLength(3);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([AAVE.SPOKE, 0n]);
  });
  it("fullRepayAmount adds a small buffer but never exceeds balance", () => {
    expect(fullRepayAmount(1_000_000_000n, 10_000_000_000n)).toBe(1_000_500_001n);
    expect(fullRepayAmount(1_000_000_000n, 1_000_100_000n)).toBe(1_000_100_000n);
  });
});

describe("explainRevert", () => {
  it("maps Aave errors to plain language", () => {
    const data = encodeErrorResult({ abi: spokeAbi, errorName: "HealthFactorBelowThreshold" });
    expect(explainRevert(data, "x")).toMatch(/past what Aave allows/);
    expect(explainRevert("0x12345678", "fallback")).toBe("fallback");
  });
  it("a failed savings withdrawal means the cash can't move right now", () => {
    const [withdraw] = buildWithdrawSavingsCalls(user, 1_500_000n, false);
    expect(explainRevert("0x47bc4b2c", "x", withdraw)).toBe(CASH_STUCK); // NotEnoughAvailableUserBalance()
    expect(explainRevert(undefined, "x", withdraw)).toBe(CASH_STUCK);
    const [, supply] = buildAddSavingsCalls(user, 1_500_000n);
    expect(explainRevert("0x12345678", "fallback", supply)).toBe("fallback");
  });
  it("reads the swap routers' reverts, on either venue", () => {
    const revert = (message: string) => `${toFunctionSelector("Error(string)")}${encodeAbiParameters([{ type: "string" }], [message]).slice(2)}` as const;
    const quote = { venue: "aerodrome" as const, pool: 10, amountIn: 1_000_000n, amountOut: 1n };
    const [approve, aero] = buildBuyCalls({ user, stock: nvda, quote });
    const [, uni] = buildBuyCalls({ user, stock: nvda, quote: { ...quote, venue: "uniswap", pool: 3000 } });
    for (const swap of [aero, uni]) {
      expect(explainRevert(revert("Too little received"), "x", swap)).toMatch(/price moved more than 1%/);
      expect(explainRevert(revert("Transaction too old"), "x", swap)).toMatch(/took too long/);
      expect(explainRevert(revert("STF"), "x", swap)).toMatch(/cash moved/);
      expect(explainRevert(revert("SPL"), "fallback", swap)).toBe("fallback");
      expect(explainRevert("0x", "fallback", swap)).toBe("fallback");
    }
    // The same string from a call that isn't a swap stays the caller's fallback.
    expect(explainRevert(revert("STF"), "fallback", approve)).toBe("fallback");
  });
});

describe("buildLoanCalls", () => {
  it("lock + borrow in one batch, in order", () => {
    const calls = buildLoanCalls({ user, locks: [{ stock: nvda, raw: 100n }], borrowRaw: 5_000_000n });
    expect(calls.map((c) => decodeFunctionData({ abi: [...erc20Abi, ...spokeAbi], data: c.data }).functionName)).toEqual([
      "approve", "supply", "setUsingAsCollateral", "borrow",
    ]);
  });
  it("borrow only when nothing needs locking", () => {
    expect(buildLoanCalls({ user, locks: [{ stock: nvda, raw: 0n }], borrowRaw: 5_000_000n })).toHaveLength(1);
  });
  it("several stocks, then one borrow; lock-only is allowed", () => {
    const aapl = EQUITIES[0];
    expect(buildLoanCalls({ user, locks: [{ stock: nvda, raw: 1n }, { stock: aapl, raw: 2n }], borrowRaw: 1n })).toHaveLength(7);
    expect(buildLoanCalls({ user, locks: [{ stock: nvda, raw: 1n }], borrowRaw: 0n })).toHaveLength(3);
    expect(() => buildLoanCalls({ user, locks: [], borrowRaw: 0n })).toThrow();
  });
});

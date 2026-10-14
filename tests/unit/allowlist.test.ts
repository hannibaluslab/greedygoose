import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import { buildBorrowCalls, buildRepayCalls, buildSupplyCalls, buildWithdrawCalls } from "@/lib/aave/tx";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { buildAddSavingsCalls, buildWithdrawSavingsCalls } from "@/lib/guardian/permission";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { GUARDIAN } from "@/lib/guardian/config";
import { AAVE } from "@/lib/aave/addresses";
import { swapRouter02Abi } from "@/lib/swap/abis";
import { UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const user = "0x000000000000000000000000000000000000dEaD";
const attacker = "0x00000000000000000000000000000000000000ee";
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const quote: BuyQuote = { venue: "uniswap", pool: 3000, amountIn: 1_000_000n, amountOut: 295_545n };
const approve = (token: `0x${string}`, spender: `0x${string}`) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1n] }),
  value: 0n,
});
const swap = (tokenOut: `0x${string}`, recipient: `0x${string}`) => ({
  to: UNISWAP.SWAP_ROUTER_02,
  data: encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [{ tokenIn: USDC.address, tokenOut, fee: 3000, recipient, amountIn: 1n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
  }),
  value: 0n,
});

describe("assertAllowed (one allowlist for every user batch)", () => {
  it("passes what the builders make, savings withdrawals included", () => {
    const batch = [
      ...buildWithdrawSavingsCalls(user, 1_500_000n, false),
      ...buildWithdrawSavingsCalls(user, 0n, true),
      ...buildBuyCalls({ user, stock: nvda, quote }),
      ...buildBuyCalls({ user, stock: nvda, quote: { ...quote, venue: "aerodrome", pool: 10 } }),
      ...buildRepayCalls({ user, amountRaw: 1_000_000n, all: true }),
      ...buildSupplyCalls({ user, stock: nvda, amountRaw: 1n }),
      ...buildWithdrawCalls({ user, stock: nvda, amountRaw: 1n, all: false }),
      ...buildBorrowCalls({ user, amountRaw: 1n }),
    ];
    expect(assertAllowed(user, batch)).toBe(batch);
  });

  it("blocks unknown targets and any value", () => {
    expect(() => assertAllowed(user, [{ to: attacker, data: "0x", value: 0n }])).toThrow(/unexpected target/);
    const [w] = buildWithdrawSavingsCalls(user, 1n, false);
    expect(() => assertAllowed(user, [{ ...w, value: 1n }])).toThrow(/unexpected value/);
  });

  it("holds each target to its own functions", () => {
    // Buys and repays only take savings out; putting them in is not part of these batches.
    const supply = buildAddSavingsCalls(user, 1n)[1];
    expect(() => assertAllowed(user, [supply])).toThrow(/unexpected call/);
    const transfer = { to: USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, 1n] }), value: 0n };
    expect(() => assertAllowed(user, [transfer])).toThrow(/unexpected call/);
    const poolTransfer = { ...transfer, to: GUARDIAN.AAVE_V3_POOL };
    expect(() => assertAllowed(user, [poolTransfer])).toThrow(/unexpected call/);
    const withdrawOnRouter = { to: UNISWAP.SWAP_ROUTER_02, data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "withdraw", args: [USDC.address, 1n, user] }), value: 0n };
    expect(() => assertAllowed(user, [withdrawOnRouter])).toThrow(/unexpected call/);
  });

  it("approves only the spoke and the routers", () => {
    expect(() => assertAllowed(user, [approve(USDC.address, AAVE.SPOKE), approve(nvda.address, UNISWAP.SWAP_ROUTER_02)])).not.toThrow();
    expect(() => assertAllowed(user, [approve(USDC.address, attacker)])).toThrow(/unexpected spender/);
    expect(() => assertAllowed(user, [approve(USDC.address, GUARDIAN.AAVE_V3_POOL)])).toThrow(/unexpected spender/);
  });

  it("keeps the money with the user: every withdrawal, position and swap is the user's own", () => {
    // Each builder is valid for its own account; checked against `user`, the other account's batch is refused.
    const other = [
      buildWithdrawSavingsCalls(attacker, 1n, false),
      buildBuyCalls({ user: attacker, stock: nvda, quote }),
      buildRepayCalls({ user: attacker, amountRaw: 1n, all: false }),
      buildSupplyCalls({ user: attacker, stock: nvda, amountRaw: 1n }),
      buildWithdrawCalls({ user: attacker, stock: nvda, amountRaw: 1n, all: false }),
      buildBorrowCalls({ user: attacker, amountRaw: 1n }),
    ];
    for (const batch of other) expect(() => assertAllowed(user, batch)).toThrow(/unexpected arguments/);
  });

  it("takes only USDC out of savings, and swaps only between registry tokens", () => {
    const withdrawStock = { to: GUARDIAN.AAVE_V3_POOL, data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "withdraw", args: [nvda.address, 1n, user] }), value: 0n };
    expect(() => assertAllowed(user, [withdrawStock])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [swap(nvda.address, user)])).not.toThrow();
    expect(() => assertAllowed(user, [swap(attacker, user)])).toThrow(/unexpected arguments/);
  });
});

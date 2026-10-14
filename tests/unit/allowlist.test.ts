import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import { buildBorrowCalls, buildRepayCalls, buildSupplyCalls, buildWithdrawCalls } from "@/lib/aave/tx";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { buildAddSavingsCalls, buildWithdrawSavingsCalls } from "@/lib/guardian/permission";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { GUARDIAN } from "@/lib/guardian/config";
import { AAVE } from "@/lib/aave/addresses";
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

describe("assertAllowed (one allowlist for every user batch)", () => {
  it("passes what the builders make, savings withdrawals included", () => {
    const batch = [
      ...buildWithdrawSavingsCalls(user, 1_500_000n, false),
      ...buildWithdrawSavingsCalls(user, 0n, true),
      ...buildBuyCalls({ user, stock: nvda, quote }),
      ...buildRepayCalls({ user, amountRaw: 1_000_000n, all: true }),
      ...buildSupplyCalls({ user, stock: nvda, amountRaw: 1n }),
      ...buildWithdrawCalls({ user, stock: nvda, amountRaw: 1n, all: false }),
      ...buildBorrowCalls({ user, amountRaw: 1n }),
    ];
    expect(assertAllowed(batch)).toBe(batch);
  });

  it("blocks unknown targets and any value", () => {
    expect(() => assertAllowed([{ to: attacker, data: "0x", value: 0n }])).toThrow(/unexpected target/);
    const [w] = buildWithdrawSavingsCalls(user, 1n, false);
    expect(() => assertAllowed([{ ...w, value: 1n }])).toThrow(/unexpected value/);
  });

  it("holds each target to its own functions", () => {
    // Buys and repays only take savings out; putting them in is not part of these batches.
    const supply = buildAddSavingsCalls(user, 1n)[1];
    expect(() => assertAllowed([supply])).toThrow(/unexpected call/);
    const transfer = { to: USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, 1n] }), value: 0n };
    expect(() => assertAllowed([transfer])).toThrow(/unexpected call/);
    const poolTransfer = { ...transfer, to: GUARDIAN.AAVE_V3_POOL };
    expect(() => assertAllowed([poolTransfer])).toThrow(/unexpected call/);
    const withdrawOnRouter = { to: UNISWAP.SWAP_ROUTER_02, data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "withdraw", args: [USDC.address, 1n, user] }), value: 0n };
    expect(() => assertAllowed([withdrawOnRouter])).toThrow(/unexpected call/);
  });

  it("approves only the spoke and the routers", () => {
    expect(() => assertAllowed([approve(USDC.address, AAVE.SPOKE), approve(nvda.address, UNISWAP.SWAP_ROUTER_02)])).not.toThrow();
    expect(() => assertAllowed([approve(USDC.address, attacker)])).toThrow(/unexpected spender/);
    expect(() => assertAllowed([approve(USDC.address, GUARDIAN.AAVE_V3_POOL)])).toThrow(/unexpected spender/);
  });
});

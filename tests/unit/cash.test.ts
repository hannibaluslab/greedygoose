import { describe, expect, it } from "vitest";
import { decodeFunctionData, maxUint256, parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { maxSpendRaw, payFromCash, savingsWithdrawal } from "@/lib/cash";
import { buildRepayCalls } from "@/lib/aave/tx";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { GUARDIAN } from "@/lib/guardian/config";
import { AAVE } from "@/lib/aave/addresses";
import { USDC } from "@/lib/tokens/registry";

const user = "0x000000000000000000000000000000000000dEaD";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const fee = usd(CASH.feeBufferUsd);
const keepBack = usd(CASH.keepBackUsd);

describe("savingsWithdrawal (amount + fee buffer − min(wallet, keep-back))", () => {
  it("with a $0 wallet, takes the amount plus the fee buffer", () => {
    expect(savingsWithdrawal(usd(1), { walletRaw: 0n, savingsRaw: usd(100) })).toEqual({ raw: usd(1) + fee, all: false });
  });

  it("counts wallet USDC up to the keep-back", () => {
    const walletRaw = keepBack / 2n;
    expect(savingsWithdrawal(usd(10), { walletRaw, savingsRaw: usd(100) })).toEqual({ raw: usd(10) + fee - walletRaw, all: false });
  });

  it("never counts wallet USDC above the keep-back, which Save may sweep", () => {
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(500), savingsRaw: usd(100) })).toEqual({ raw: usd(10) + fee - keepBack, all: false });
  });

  it("takes nothing when the kept-back wallet USDC covers the spend and the fee", () => {
    const amountRaw = keepBack - fee;
    expect(amountRaw).toBeGreaterThan(0n);
    expect(savingsWithdrawal(amountRaw, { walletRaw: keepBack, savingsRaw: usd(100) })).toBeNull();
  });

  it("takes all of savings when they fall short, and nothing when there are none", () => {
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(50), savingsRaw: usd(3) })).toEqual({ raw: usd(3), all: true });
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(50), savingsRaw: 0n })).toBeNull();
  });
});

describe("maxSpendRaw", () => {
  it("is wallet + savings, less the fee buffer, never below zero", () => {
    expect(maxSpendRaw({ walletRaw: usd(2), savingsRaw: usd(8) })).toBe(usd(10) - fee);
    expect(maxSpendRaw({ walletRaw: 0n, savingsRaw: fee / 2n })).toBe(0n);
  });
});

describe("payFromCash", () => {
  const repay = buildRepayCalls({ user, amountRaw: usd(1), all: false });

  it("puts the savings withdrawal first, to the user, in the same batch", () => {
    const calls = payFromCash(user, usd(1), { walletRaw: 0n, savingsRaw: usd(100) }, repay);
    expect(calls.map((c) => c.to)).toEqual([GUARDIAN.AAVE_V3_POOL, USDC.address, AAVE.SPOKE]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data })).toMatchObject({
      functionName: "withdraw",
      args: [USDC.address, usd(1) + fee, user],
    });
  });

  it("withdraws everything (max uint) when savings are the last of the cash", () => {
    const calls = payFromCash(user, usd(1), { walletRaw: 0n, savingsRaw: usd(1) + fee }, repay);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([USDC.address, maxUint256, user]);
  });

  it("leaves the batch alone when the wallet covers it", () => {
    expect(payFromCash(user, usd(1), { walletRaw: keepBack + usd(1), savingsRaw: 0n }, repay)).toEqual(repay);
  });

  it("refuses more than the cash can pay", () => {
    expect(() => payFromCash(user, usd(10), { walletRaw: usd(4), savingsRaw: usd(6) }, repay)).toThrow(/More than your cash/);
  });
});

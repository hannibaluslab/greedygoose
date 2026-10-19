import { describe, expect, it } from "vitest";
import { decodeFunctionData, maxUint256, parseUnits } from "viem";
import { CASH } from "@/config/risk";
import { cantRepay, cashShort, maxSpendRaw, payFromCash, saveRuns, savingsWithdrawal } from "@/lib/cash";
import { readCash } from "@/lib/cash/read";
import { buildRepayCalls } from "@/lib/aave/tx";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { AAVE } from "@/lib/aave/addresses";
import { USDC } from "@/lib/tokens/registry";

const user = "0x000000000000000000000000000000000000dEaD";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const fee = usd(CASH.feeBufferUsd);
const keepBack = usd(CASH.keepBackUsd);

describe("savingsWithdrawal while Save is on (amount + fee buffer − min(wallet, keep-back))", () => {
  it("with a $0 wallet, takes the amount plus the fee buffer", () => {
    expect(savingsWithdrawal(usd(1), { walletRaw: 0n, savingsRaw: usd(100), saveOn: true })).toEqual({
      raw: usd(1) + fee,
      all: false,
    });
  });

  it("counts wallet USDC up to the keep-back", () => {
    const walletRaw = keepBack / 2n;
    expect(savingsWithdrawal(usd(10), { walletRaw, savingsRaw: usd(100), saveOn: true })).toEqual({
      raw: usd(10) + fee - walletRaw,
      all: false,
    });
  });

  it("never counts wallet USDC above the keep-back, which Save may sweep", () => {
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(500), savingsRaw: usd(100), saveOn: true })).toEqual({
      raw: usd(10) + fee - keepBack,
      all: false,
    });
  });

  it("takes nothing when the kept-back wallet USDC covers the spend and the fee", () => {
    const amountRaw = keepBack - fee;
    expect(amountRaw).toBeGreaterThan(0n);
    expect(savingsWithdrawal(amountRaw, { walletRaw: keepBack, savingsRaw: usd(100), saveOn: true })).toBeNull();
  });

  it("takes all of savings when they fall short, and nothing when there are none", () => {
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(50), savingsRaw: usd(3), saveOn: true })).toEqual({
      raw: usd(3),
      all: true,
    });
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(50), savingsRaw: 0n, saveOn: true })).toBeNull();
  });
});

describe("savingsWithdrawal while Save is off (wallet USDC first, then savings)", () => {
  it("counts the whole wallet, since nothing will sweep it", () => {
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(500), savingsRaw: usd(100), saveOn: false })).toBeNull();
    expect(savingsWithdrawal(usd(10), { walletRaw: usd(4), savingsRaw: usd(100), saveOn: false })).toEqual({
      raw: usd(10) + fee - usd(4),
      all: false,
    });
  });

  it("takes everything from savings with a $0 wallet, the same as with Save on", () => {
    const c = { walletRaw: 0n, savingsRaw: usd(100) };
    expect(savingsWithdrawal(usd(1), { ...c, saveOn: false })).toEqual(
      savingsWithdrawal(usd(1), { ...c, saveOn: true }),
    );
  });

  it("leaves a batch alone when the wallet covers it", () => {
    const repay = buildRepayCalls({ user, amountRaw: usd(10) });
    expect(payFromCash(user, usd(10), { walletRaw: usd(20), savingsRaw: usd(100), saveOn: false }, repay)).toEqual(
      repay,
    );
  });
});

describe("maxSpendRaw", () => {
  it("is wallet + savings, less the fee buffer, never below zero", () => {
    expect(maxSpendRaw({ walletRaw: usd(2), savingsRaw: usd(8), saveOn: true })).toBe(usd(10) - fee);
    expect(maxSpendRaw({ walletRaw: 0n, savingsRaw: fee / 2n, saveOn: true })).toBe(0n);
  });
});

describe("payFromCash", () => {
  const repay = buildRepayCalls({ user, amountRaw: usd(1) });

  it("puts the savings withdrawal first, to the user, in the same batch", () => {
    const calls = payFromCash(user, usd(1), { walletRaw: 0n, savingsRaw: usd(100), saveOn: true }, repay);
    expect(calls.map((c) => c.to)).toEqual([PROTOCOLS.AAVE_V3_POOL, USDC.address, AAVE.SPOKE, USDC.address]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data })).toMatchObject({
      functionName: "withdraw",
      args: [USDC.address, usd(1) + fee, user],
    });
  });

  it("withdraws everything (max uint) when savings are the last of the cash", () => {
    const calls = payFromCash(user, usd(1), { walletRaw: 0n, savingsRaw: usd(1) + fee, saveOn: true }, repay);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data }).args).toEqual([
      USDC.address,
      maxUint256,
      user,
    ]);
  });

  it("leaves the batch alone when the wallet covers it", () => {
    expect(payFromCash(user, usd(1), { walletRaw: keepBack + usd(1), savingsRaw: 0n, saveOn: true }, repay)).toEqual(
      repay,
    );
  });

  it("refuses more than the cash can pay", () => {
    expect(() => payFromCash(user, usd(10), { walletRaw: usd(4), savingsRaw: usd(6), saveOn: true }, repay)).toThrow(
      /More than your cash/,
    );
  });
});

describe("cashShort (the cash read again right before Face ID)", () => {
  const c = { walletRaw: usd(4), savingsRaw: usd(6), saveOn: true };

  it("lets a spend through while it and the fee buffer fit, to the last unit", () => {
    expect(cashShort(usd(10) - fee, c)).toBeNull();
    expect(cashShort(usd(1), c)).toBeNull();
  });

  it("stops a spend the cash no longer covers, saying what's there now", () => {
    expect(cashShort(usd(10) - fee + 1n, c)).toBe(
      "Your cash moved since you started. You have $10.00 now: check the amount and try again.",
    );
    expect(cashShort(usd(300), { walletRaw: 0n, savingsRaw: usd(120.5), saveOn: false })).toMatch(
      /You have \$120\.50 now/,
    );
  });

  it("counts savings and wallet alike (D15)", () => {
    expect(cashShort(usd(5), { walletRaw: 0n, savingsRaw: usd(5) + fee, saveOn: true })).toBeNull();
    expect(cashShort(usd(5), { walletRaw: usd(5) + fee, savingsRaw: 0n, saveOn: true })).toBeNull();
  });
});

describe("cantRepay (the Repay screen with no amount to offer)", () => {
  it("asks for money when there's no cash", () => {
    expect(cantRepay({ walletRaw: 0n, savingsRaw: 0n, saveOn: false })).toBe("Add money to your cash to repay.");
  });

  it("says the fee buffer stays for the network fee when cash is no more than it, in savings or the wallet", () => {
    const words = `Repaying needs more than $${CASH.feeBufferUsd.toFixed(2)} in your cash: that much stays for the network fee.`;
    expect(cantRepay({ walletRaw: fee / 2n, savingsRaw: 0n, saveOn: false })).toBe(words);
    expect(cantRepay({ walletRaw: 0n, savingsRaw: fee, saveOn: true })).toBe(words);
    expect(maxSpendRaw({ walletRaw: 0n, savingsRaw: fee, saveOn: true })).toBe(0n);
  });

  it("never says USDC or wallet", () => {
    for (const c of [
      { walletRaw: 0n, savingsRaw: 0n, saveOn: false },
      { walletRaw: fee, savingsRaw: 0n, saveOn: false },
    ]) {
      expect(cantRepay(c)).not.toMatch(/USDC|wallet|account/i);
    }
  });
});

describe("saveRuns", () => {
  it("reads Save's bit from the executor's job bits (JOBS' order: save, protect)", () => {
    expect(saveRuns(0)).toBe(false);
    expect(saveRuns(0b01)).toBe(true);
    expect(saveRuns(0b10)).toBe(false);
    expect(saveRuns(0b11)).toBe(true);
  });
});

describe("readCash", () => {
  it("reads wallet USDC and savings for the account in one multicall; Save is off until the executor is set", async () => {
    const asked: unknown[] = [];
    const client = {
      multicall: async ({ contracts }: { contracts: unknown[] }) => {
        asked.push(...contracts);
        return [usd(2), usd(30)];
      },
      readContract: async () => {
        throw new Error("no executor is configured in tests");
      },
    } as unknown as Parameters<typeof readCash>[0];
    expect(await readCash(client, user)).toEqual({ walletRaw: usd(2), savingsRaw: usd(30), saveOn: false });
    expect(asked).toMatchObject([
      { address: USDC.address, functionName: "balanceOf", args: [user] },
      { address: PROTOCOLS.AUSDC, functionName: "balanceOf", args: [user] },
    ]);
  });
});

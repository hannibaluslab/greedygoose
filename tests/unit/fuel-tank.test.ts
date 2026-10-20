import { describe, expect, it } from "vitest";
import { decodeFunctionData, maxUint256 } from "viem";
import { CASH } from "@/config/risk";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { fillRaw, fillTankPlan, tankLevelUsd, tankLow } from "@/lib/fuelTank";
import { USDC } from "@/lib/tokens/registry";

const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const cash = (wallet: number, savings: number) => ({
  walletRaw: usdc(wallet),
  savingsRaw: usdc(savings),
  saveOn: false,
});

describe("the fuel tank: $0.50 of wallet cash for network fees, filled from savings (Adrian, 2026-10-20)", () => {
  it("is $0.50", () => {
    expect(CASH.feeBufferUsd).toBe(0.5);
  });

  it("reads what's in the wallet up to the tank, rounded down to the cent", () => {
    expect(tankLevelUsd(usdc(0.123))).toBe(0.12);
    expect(tankLevelUsd(usdc(0.4999))).toBe(0.49);
    expect(tankLevelUsd(usdc(0.5))).toBe(0.5);
    expect(tankLevelUsd(usdc(400))).toBe(0.5);
    expect(tankLevelUsd(0n)).toBe(0);
  });

  it("asks for a fill-up in the menu only under half full, and only with savings to fill it from", () => {
    expect(tankLow(cash(0.24, 10))).toBe(true);
    expect(tankLow(cash(0.25, 10))).toBe(false);
    expect(tankLow(cash(0.1, 0))).toBe(false);
  });

  it("fills back to full plus its own fee, all of savings when that's less, nothing when full", () => {
    expect(fillRaw(cash(0.12, 100))).toEqual({ raw: usdc(0.5 + 0.02 - 0.12), all: false });
    expect(fillRaw(cash(0.12, 0.2))).toEqual({ raw: usdc(0.2), all: true });
    expect(fillRaw(cash(0.5, 100))).toBeNull();
    expect(fillRaw(cash(0.12, 0))).toBeNull();
  });

  it("signs one savings withdrawal to the user, from the cash read again, and stops when it filled up meanwhile", async () => {
    const plan = fillTankPlan(user, cash(0.12, 100), () => Promise.resolve(cash(0.1, 100)))!;
    const [call] = await (plan.calls as () => Promise<{ data: `0x${string}` }[]>)();
    const { functionName, args } = decodeFunctionData({ abi: aaveV3PoolAbi, data: call.data });
    expect(functionName).toBe("withdraw");
    expect(args).toEqual([USDC.address, usdc(0.5 + 0.02 - 0.1), user]);
    const all = fillTankPlan(user, cash(0.12, 0.2), () => Promise.resolve(cash(0.12, 0.2)))!;
    const [allCall] = await (all.calls as () => Promise<{ data: `0x${string}` }[]>)();
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: allCall.data }).args?.[1]).toBe(maxUint256);
    const full = fillTankPlan(user, cash(0.12, 100), () => Promise.resolve(cash(0.6, 100)))!;
    await expect((full.calls as () => Promise<unknown>)()).rejects.toThrow(/already full/);
    expect(fillTankPlan(user, cash(0.5, 100), () => Promise.resolve(cash(0.5, 100)))).toBeNull();
  });

  it("keeps one batch while interest ticks in savings", () => {
    const read = () => Promise.resolve(cash(0.12, 100));
    expect(fillTankPlan(user, cash(0.12, 100), read)!.key).toBe(fillTankPlan(user, cash(0.12, 100.01), read)!.key);
    expect(fillTankPlan(user, cash(0.12, 100), read)!.key).not.toBe(fillTankPlan(user, cash(0.11, 100), read)!.key);
  });
});

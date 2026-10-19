import { describe, expect, it } from "vitest";
import { decodeFunctionData, maxUint256 } from "viem";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { AAVE } from "@/lib/aave/addresses";
import { buildRepayCalls } from "@/lib/aave/tx";
import { FREE_UP_FLOOR } from "@/lib/freeUpPlan";
import { EQUITIES } from "@/lib/tokens/registry";
import { takeOutPlan, withTakeOuts } from "@/lib/tx/plans";
import { txKey, type TxPlan } from "@/lib/tx/prepared";

const SAM = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const amzn = EQUITIES.find((e) => e.symbol === "AMZNc")!;
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;

const repay: TxPlan = {
  key: txKey("repay", SAM, 200_000_000n),
  user: SAM,
  calls: () => Promise.resolve(buildRepayCalls({ user: SAM, amountRaw: 200_000_000n })),
  activity: [{ kind: "repay", symbol: "USDC", amount: 200 }],
};
const spokeCall = (data: `0x${string}`) => decodeFunctionData({ abi: spokeAbi, data });
const resolve = async (p: TxPlan) => (typeof p.calls === "function" ? p.calls() : p.calls);

describe("withTakeOuts: repay and free up in one signature", () => {
  it("repays first, then takes each stock out to the user: an amount, or all of it", async () => {
    const plan = withTakeOuts(repay, [
      { stock: amzn, amountRaw: 0n, all: true },
      { stock: aapl, amountRaw: 600_000n, all: false },
    ]);
    const calls = await resolve(plan);
    const repayCalls = await resolve(repay);
    expect(calls.slice(0, repayCalls.length)).toEqual(repayCalls);
    const outs = calls.slice(repayCalls.length);
    expect(outs.every((c) => c.to === AAVE.SPOKE)).toBe(true);
    expect(outs.map((c) => spokeCall(c.data))).toMatchObject([
      { functionName: "withdraw", args: [BigInt(amzn.reserveId), maxUint256, SAM] },
      { functionName: "withdraw", args: [BigInt(aapl.reserveId), 600_000n, SAM] },
    ]);
  });

  it("is held to the Act line on Aave's own health, and says what comes out", () => {
    const plan = withTakeOuts(repay, [{ stock: aapl, amountRaw: 600_000n, all: false }]);
    expect(plan.healthFloor).toBe(FREE_UP_FLOOR);
    expect(plan.activity).toEqual([
      { kind: "repay", symbol: "USDC", amount: 200 },
      { kind: "withdraw", symbol: "AAPLc", amount: 600_000 / 10 ** aapl.decimals },
    ]);
  });

  it("is keyed by the repay and every take-out", () => {
    const k = (outs: Parameters<typeof withTakeOuts>[1]) => withTakeOuts(repay, outs).key;
    const base = k([{ stock: aapl, amountRaw: 600_000n, all: false }]);
    for (const other of [
      k([{ stock: aapl, amountRaw: 600_001n, all: false }]),
      k([{ stock: aapl, amountRaw: 600_000n, all: true }]),
      k([{ stock: amzn, amountRaw: 600_000n, all: false }]),
      k([
        { stock: aapl, amountRaw: 600_000n, all: false },
        { stock: amzn, amountRaw: 1n, all: false },
      ]),
      withTakeOuts({ ...repay, key: txKey("repay", SAM, 1n) }, [{ stock: aapl, amountRaw: 600_000n, all: false }]).key,
    ])
      expect(other).not.toBe(base);
  });

  it("with nothing ticked, it is the repay unchanged", () => {
    expect(withTakeOuts(repay, [])).toBe(repay);
  });
});

describe("takeOutPlan: free up with nothing repaid", () => {
  it("takes the stocks out, held to the same line", async () => {
    const plan = takeOutPlan(SAM, [{ stock: aapl, amountRaw: 350_000n, all: false }]);
    expect(plan.healthFloor).toBe(FREE_UP_FLOOR);
    expect((await resolve(plan)).map((c) => spokeCall(c.data))).toMatchObject([
      { functionName: "withdraw", args: [BigInt(aapl.reserveId), 350_000n, SAM] },
    ]);
    expect(plan.key).not.toBe(takeOutPlan(SAM, [{ stock: aapl, amountRaw: 350_001n, all: false }]).key);
  });
});

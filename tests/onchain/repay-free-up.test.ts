/**
 * Repay + free up on Base (canvas boards 3–7), simulated with eth_simulateV1: nothing is sent. The position is set up
 * in the same simulation, from an account that backs no credit ($20 of its NVIDIA in use and credit to a health of
 * 1.75), so it doesn't hang on any real account. Then, in one batch after it: the repay, then the take-outs.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, erc20Abi, http, parseUnits } from "viem";
import { CREDIT_CAP } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { explainRevert } from "@/lib/aave/errors";
import { priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { buildBackAndCreditCalls, buildRepayCalls, fullRepayAmount, type Call } from "@/lib/aave/tx";
import { CHAIN } from "@/lib/chain";
import { FREE_UP_BLOCKED, freeAll, planFreeUp } from "@/lib/freeUpPlan";
import { statusFor } from "@/lib/risk/status";
import { EQUITIES } from "@/lib/tokens/registry";
import { takeOutPlan, withTakeOuts } from "@/lib/tx/plans";
import { checkPlan, txKey, type CheckDeps, type TxPlan } from "@/lib/tx/prepared";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });
// Holds NVIDIA and backs no credit (flows.test.ts and credit-buy.test.ts use it the same way).
const newcomer = "0xb5ef91ce939f2c390cff462bb231e74bb228deb4" as const;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

async function setUp() {
  const id = BigInt(nvda.reserveId);
  const [price, reserve, free] = await Promise.all([
    client.readContract({
      address: AAVE.SPOKE_ORACLE,
      abi: aaveOracleAbi,
      functionName: "getReservePrice",
      args: [id],
    }),
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserve", args: [id] }),
    client.readContract({ address: nvda.address, abi: erc20Abi, functionName: "balanceOf", args: [newcomer] }),
  ]);
  const dyn = await client.readContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "getDynamicReserveConfig",
    args: [id, reserve.dynamicConfigKey],
  });
  const cf = dyn.collateralFactor / 10_000;
  const usdPerRaw = priceToUsd(price) / 10 ** nvda.decimals;
  const backingRaw = BigInt(Math.floor(20 / usdPerRaw));
  expect(free).toBeGreaterThanOrEqual(backingRaw);
  const backingUsd = Number(backingRaw) * usdPerRaw;
  const debtUsd = Math.floor(((backingUsd * cf) / 1.75) * 1e6) / 1e6;
  const debtRaw = parseUnits(debtUsd.toFixed(6), 6);
  const setup = buildBackAndCreditCalls({
    user: newcomer,
    backing: [{ stock: nvda, raw: backingRaw }],
    creditRaw: debtRaw,
  });
  return { cf, backingRaw, backingUsd, debtUsd, debtRaw, setup };
}

const accountRead = {
  to: AAVE.SPOKE,
  data: encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [newcomer] }),
};

/** The batch after the set-up position: every call goes through, and the account on Aave after it. */
async function landing(setup: Call[], batch: Call[]) {
  const r = await client.simulateCalls({
    account: newcomer,
    calls: [...setup, ...batch, accountRead].map(({ to, data }) => ({ to, data })),
  });
  const failed = r.results.slice(0, -1).findIndex((x) => x.status !== "success");
  expect(failed, `call ${failed} reverted`).toBe(-1);
  return summarize(
    decodeFunctionResult({
      abi: spokeAbi,
      functionName: "getUserAccountData",
      data: r.results.at(-1)!.data,
    }) as AccountData,
  );
}

const repayPlan = (amountRaw: bigint, all: boolean): TxPlan => ({
  key: txKey("repay", newcomer, amountRaw, all),
  user: newcomer,
  calls: () => Promise.resolve(buildRepayCalls({ user: newcomer, amountRaw })),
});
const resolve = async (p: TxPlan) => (typeof p.calls === "function" ? p.calls() : p.calls);

describe("Repay + free up on Base", () => {
  it("repays part and takes out the planner's most of the stock in one batch: it lands on the line, in Watch", async () => {
    const s = await setUp();
    const position = { totalBackingUsd: s.backingUsd, avgCf: s.cf, debtUsd: s.debtUsd };
    const repayUsd = Math.floor(s.debtUsd * 0.25 * 100) / 100;
    const stocks = [
      { symbol: nvda.symbol, backingRaw: s.backingRaw, backingUsd: s.backingUsd, cf: s.cf, paused: false },
    ];
    const plan = planFreeUp({
      position,
      repayUsd,
      repaysAll: false,
      stocks,
      picks: [{ symbol: nvda.symbol, share: 1 }],
    });
    const out = plan.frees[0];
    expect(out.all).toBe(false);
    const batch = withTakeOuts(repayPlan(parseUnits(repayUsd.toFixed(2), 6), false), [
      { stock: nvda, amountRaw: out.raw, all: false },
    ]);
    const after = await landing(s.setup, await resolve(batch));
    console.log(
      `Repay $${repayUsd} of $${s.debtUsd.toFixed(2)} + free up ${(plan.rows[0].share * 100).toFixed(1)}% of $20 NVIDIA: health ${after.healthFactor!.toFixed(4)} (planned ${plan.hfAfter!.toFixed(4)})`,
    );
    expect(statusFor(after.healthFactor)).toBe("watch");
    expect(after.healthFactor!).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 0.002);
    expect(after.healthFactor!).toBeLessThan(CREDIT_CAP.minHf + 0.02);
  });

  it("the app's own check passes that batch, and stops one that takes out more than the line allows", async () => {
    const s = await setUp();
    const deps: CheckDeps = {
      join: async (_u, batch) => batch,
      simulate: async (u, batch) =>
        (
          await client.simulateCalls({
            account: u,
            calls: [...s.setup, ...batch].map(({ to, data }) => ({ to, data })),
          })
        ).results.slice(s.setup.length),
      explain: explainRevert,
    };
    const position = { totalBackingUsd: s.backingUsd, avgCf: s.cf, debtUsd: s.debtUsd };
    const stocks = [
      { symbol: nvda.symbol, backingRaw: s.backingRaw, backingUsd: s.backingUsd, cf: s.cf, paused: false },
    ];
    const plan = planFreeUp({
      position,
      repayUsd: 0,
      repaysAll: false,
      stocks,
      picks: [{ symbol: nvda.symbol, share: 1 }],
    });
    const most = plan.frees[0].raw;
    expect((await checkPlan(takeOutPlan(newcomer, [{ stock: nvda, amountRaw: most, all: false }]), deps)).ok).toBe(
      true,
    );
    // 11% over the most, with nothing repaid: a health of about 1.05, which Aave allows (over 1.0) and the app's line doesn't.
    const tooMuch = takeOutPlan(newcomer, [{ stock: nvda, amountRaw: (most * 111n) / 100n, all: false }]);
    expect(await checkPlan(tooMuch, deps)).toEqual({ ok: false, error: FREE_UP_BLOCKED.act, blocks: true });
  });

  it("repay all returns every stock in the same batch: nothing owed, nothing backing", async () => {
    const s = await setUp();
    const position = { totalBackingUsd: s.backingUsd, avgCf: s.cf, debtUsd: s.debtUsd };
    const stocks = [
      { symbol: nvda.symbol, backingRaw: s.backingRaw, backingUsd: s.backingUsd, cf: s.cf, paused: false },
    ];
    const plan = planFreeUp({ position, repayUsd: s.debtUsd, repaysAll: true, stocks, picks: freeAll(stocks) });
    expect(plan.frees).toEqual([{ symbol: nvda.symbol, raw: s.backingRaw, all: true }]);
    // The credit is still in the wallet, so the repay can pay the debt plus Aave's interest buffer.
    const amountRaw = fullRepayAmount(s.debtRaw, s.debtRaw * 2n);
    const batch = withTakeOuts(repayPlan(amountRaw, true), [{ stock: nvda, amountRaw: s.backingRaw, all: true }]);
    const after = await landing(s.setup, await resolve(batch));
    expect(after.debtUsd).toBe(0);
    expect(after.totalBackingUsd).toBe(0);
    expect(after.healthFactor).toBeNull();
  });
});

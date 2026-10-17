/**
 * Simulates the app's real write batches on Base mainnet (eth_simulateV1), from a real
 * Equities Hub borrower. Nothing is signed or sent.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseUnits,
  toFunctionSelector,
  zeroHash,
} from "viem";
import { CHAIN } from "@/lib/chain";
import { CASH, CREDIT_CAP } from "@/config/risk";
import { buildBorrowCalls, buildLoanCalls, buildRepayCalls, buildSupplyCalls, buildWithdrawCalls } from "@/lib/aave/tx";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { maxWithdrawUsd, priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { FREE_UP_BLOCKED, freeUpCheck } from "@/lib/freeUp";
import { checkPlan, type CheckDeps } from "@/lib/tx/prepared";
import { withdrawPlan } from "@/lib/tx/plans";
import { statusFor } from "@/lib/risk/status";
import { AAVE } from "@/lib/aave/addresses";
import { CASH_STUCK, explainRevert } from "@/lib/aave/errors";
import { decodeActivity } from "@/lib/activity/decode";
import { cashRaw, cashShort, payFromCash, readCash, type Cash } from "@/lib/cash";
import { PROTOCOLS } from "@/lib/protocols/config";
import { buildWithdrawSavingsCalls } from "@/lib/savings";
import { aeroQuoterAbi } from "@/lib/swap/abis";
import { buildBuyCalls } from "@/lib/swap/buy";
import { AERODROME } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });
const user = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427"; // real borrower with stock collateral (found via spoke Borrow logs)

const simulate = (calls: { to: `0x${string}`; data: `0x${string}` }[]) =>
  client.simulateCalls({ account: user, calls: calls.map(({ to, data }) => ({ to, data })) });

describe("write batches simulate on mainnet", () => {
  it("borrow $1 then repay $1", async () => {
    const r = await simulate([
      ...buildBorrowCalls({ user, amountRaw: 1_000_000n }),
      ...buildRepayCalls({ user, amountRaw: 1_000_000n, all: false }),
    ]);
    expect(r.results.map((x) => x.status)).toEqual(["success", "success", "success"]);
  });

  it("supply a free stock balance as collateral", async () => {
    let done = false;
    for (const stock of EQUITIES) {
      const bal = await client.readContract({
        address: stock.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
      });
      if (bal === 0n) continue;
      const r = await simulate(buildSupplyCalls({ user, stock, amountRaw: bal }));
      expect(r.results.map((x) => x.status)).toEqual(["success", "success", "success"]);
      done = true;
      break;
    }
    expect(done).toBe(true);
  });

  it("borrowing far past the limit is rejected by Aave", async () => {
    const r = await simulate(buildBorrowCalls({ user, amountRaw: 10n ** 12n })); // $1M
    expect(r.results[0].status).toBe("failure");
    const msg = explainRevert(r.results[0].data, "fallback");
    console.log("over-limit borrow →", msg);
    expect(msg).not.toBe("fallback");
  });

  it("unlock a small slice of collateral, and refuse unlocking everything while in debt", async () => {
    const stock = EQUITIES.find((e) => e.symbol === "AMZNc")!;
    const supplied = await client.readContract({
      address: AAVE.SPOKE,
      abi: spokeAbi,
      functionName: "getUserSuppliedAssets",
      args: [BigInt(stock.reserveId), user],
    });
    expect(supplied).toBeGreaterThan(0n);
    const small = await simulate(buildWithdrawCalls({ user, stock, amountRaw: supplied / 100n, all: false }));
    expect(small.results[0].status).toBe("success");
    // Withdrawing every stock at once would leave the debt uncovered.
    const everything = await simulate(
      EQUITIES.flatMap((e) => buildWithdrawCalls({ user, stock: e, amountRaw: 0n, all: true })),
    );
    expect(everything.results.some((r) => r.status === "failure")).toBe(true);
  });

  it("get a loan: lock a free balance + borrow $1 in one batch", async () => {
    for (const stock of EQUITIES) {
      const bal = await client.readContract({
        address: stock.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
      });
      if (bal === 0n) continue;
      const r = await simulate(buildLoanCalls({ user, locks: [{ stock, raw: bal }], borrowRaw: 1_000_000n }));
      expect(r.results.map((x) => x.status)).toEqual(["success", "success", "success", "success"]);
      return;
    }
    throw new Error("no free stock to test with");
  });

  it("get a loan with several stocks at once", async () => {
    const locks = [];
    for (const stock of EQUITIES) {
      const bal = await client.readContract({
        address: stock.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
      });
      if (bal > 0n) locks.push({ stock, raw: bal });
      if (locks.length === 2) break;
    }
    expect(locks.length).toBeGreaterThanOrEqual(2);
    const r = await simulate(buildLoanCalls({ user, locks, borrowRaw: 1_000_000n }));
    expect(r.results.every((x) => x.status === "success")).toBe(true);
    expect(r.results).toHaveLength(locks.length * 3 + 1);
  });
});

/**
 * Cash is savings (D15): the same borrower also holds aBasUSDC. A state override empties its wallet
 * USDC, so every dollar of these buys and repays (and the fee buffer) comes out of savings.
 */
describe("savings-first batches from a $0 wallet", () => {
  // FiatTokenV2_2 keeps balances in the mapping at slot 9; the first test checks it against balanceOf.
  const walletSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, 9n]));
  const emptyWallet = [{ address: USDC.address, stateDiff: [{ slot: walletSlot, value: zeroHash }] }];
  const walletRead = {
    to: USDC.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }),
  };
  const feeBuffer = parseUnits(CASH.feeBufferUsd.toFixed(6), 6);

  const cash = async (): Promise<Cash> => ({
    walletRaw: 0n,
    savingsRaw: await client.readContract({
      address: PROTOCOLS.AUSDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    }),
    saveOn: false,
  });

  /** Simulates the batch with an empty wallet, then reads what the wallet holds after it. */
  async function simulateFromEmptyWallet(calls: { to: `0x${string}`; data: `0x${string}` }[]) {
    const r = await client.simulateCalls({
      account: user,
      calls: [...calls, walletRead].map(({ to, data }) => ({ to, data })),
      stateOverrides: emptyWallet,
    });
    return {
      statuses: r.results.slice(0, -1).map((x) => x.status),
      walletAfter: decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.results.at(-1)!.data }),
      /** What Activity shows for it: the batch's events, as its receipt would carry them. */
      activity: decodeActivity(
        r.results.flatMap((x) => x.logs ?? []),
        user,
      ),
    };
  }

  it("the account holds savings, and the override really empties its wallet", async () => {
    const [stored, balance] = await Promise.all([
      client.getStorageAt({ address: USDC.address, slot: walletSlot }),
      client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    ]);
    expect(BigInt(stored ?? 0)).toBe(balance);
    expect(
      await client.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
        stateOverride: emptyWallet,
      }),
    ).toBe(0n);
    expect((await cash()).savingsRaw).toBeGreaterThan(5_000_000n);
  });

  it("buy $1 of a stock: withdraw from savings → approve → swap, fee buffer left in the wallet", async () => {
    const stock = EQUITIES.find((e) => e.symbol === "NVDAc")!;
    const amountIn = 1_000_000n;
    const pool = 10;
    const { result } = await client.simulateContract({
      address: AERODROME.QUOTER,
      abi: aeroQuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: USDC.address, tokenOut: stock.address, amountIn, tickSpacing: pool, sqrtPriceLimitX96: 0n }],
    });
    const quote = { venue: "aerodrome" as const, pool, amountIn, amountOut: result[0] };
    const calls = payFromCash(user, amountIn, await cash(), buildBuyCalls({ user, stock, quote }));
    expect(calls.map((c) => c.to)).toEqual([PROTOCOLS.AAVE_V3_POOL, USDC.address, AERODROME.ROUTER]);
    const r = await simulateFromEmptyWallet(calls);
    expect(r.statuses).toEqual(["success", "success", "success"]);
    expect(r.walletAfter).toBe(feeBuffer);
    // One Activity row: the buy, paid from cash. The savings withdrawal that paid for it stays inside the cash (D20).
    expect(r.activity).toEqual([{ kind: "buy", symbol: "NVDAc", amount: Number(quote.amountOut) / 1e8, paidUsd: 1 }]);
  });

  it("repay $1: withdraw from savings → approve → repay, fee buffer left in the wallet", async () => {
    // A live account: repay $1, or all of it once it owes less (Aave takes no more than is owed).
    const owed = await client.readContract({
      address: AAVE.SPOKE,
      abi: spokeAbi,
      functionName: "getUserTotalDebt",
      args: [BigInt(USDC.reserveId), user],
    });
    expect(owed, "the test account owes nothing to repay").toBeGreaterThan(0n);
    const amountRaw = owed < 1_000_000n ? owed : 1_000_000n;
    const calls = payFromCash(user, amountRaw, await cash(), buildRepayCalls({ user, amountRaw, all: false }));
    expect(calls.map((c) => c.to)).toEqual([PROTOCOLS.AAVE_V3_POOL, USDC.address, AAVE.SPOKE]);
    const r = await simulateFromEmptyWallet(calls);
    expect(r.statuses).toEqual(["success", "success", "success"]);
    expect(r.walletAfter).toBe(feeBuffer);
    expect(r.activity).toEqual([{ kind: "repay", symbol: "USDC", amount: Number(amountRaw) / 1e6 }]);
  });

  it("a withdrawal savings can't serve reads as cash that can't move right now", async () => {
    const [withdraw] = buildWithdrawSavingsCalls(user, (await cash()).savingsRaw + 10n ** 12n, false);
    const [r] = (await client.simulateCalls({ account: user, calls: [{ to: withdraw.to, data: withdraw.data }] }))
      .results;
    expect(r.status).toBe("failure");
    expect(r.data).toBe(toFunctionSelector("NotEnoughAvailableUserBalance()"));
    expect(explainRevert(r.data, "fallback", withdraw)).toBe(CASH_STUCK);
  });
});

/** The cash read again right before Face ID (useSigningCash), from the same live account. */
describe("the cash a batch is signed with (readCash)", () => {
  const balance = (token: `0x${string}`) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [user] });

  it("reads what usePosition reads: wallet USDC and savings", async () => {
    const savingsBefore = await balance(PROTOCOLS.AUSDC);
    const [c, walletRaw] = await Promise.all([readCash(client, user), balance(USDC.address)]);
    const savingsAfter = await balance(PROTOCOLS.AUSDC);
    expect(c.walletRaw).toBe(walletRaw);
    // Savings earn by the second, so the read lands between the two around it.
    expect(c.savingsRaw).toBeGreaterThanOrEqual(savingsBefore);
    expect(c.savingsRaw).toBeLessThanOrEqual(savingsAfter);
    expect(c.saveOn).toBe(false);
  });

  it("a repay built from it simulates, and a spend past it is stopped in words", async () => {
    const c = await readCash(client, user);
    const owed = await client.readContract({
      address: AAVE.SPOKE,
      abi: spokeAbi,
      functionName: "getUserTotalDebt",
      args: [BigInt(USDC.reserveId), user],
    });
    expect(owed, "the test account owes nothing to repay").toBeGreaterThan(0n);
    const amountRaw = owed < 1_000_000n ? owed : 1_000_000n;
    expect(cashShort(amountRaw, c)).toBeNull();
    const r = await simulate(payFromCash(user, amountRaw, c, buildRepayCalls({ user, amountRaw, all: false })));
    expect(r.results.every((x) => x.status === "success")).toBe(true);
    expect(cashShort(cashRaw(c), c)).toMatch(/^Your cash moved since you started\. You have \$[\d,]+\.\d\d now/);
  });
});

/**
 * Act is the line (Adrian, 2026-10-15): Free up stops where taking credit does, at CREDIT_CAP.minHf, and the app's own
 * check (checkPlan with withdrawPlan's floor) stops a Free up that lands in Act on Aave's health. Deterministic: the
 * position is set up in the same simulation, from an account that never backed credit ($20 of its NVIDIA in use and
 * credit to a health of 1.75), so it doesn't hang on any real account's health drifting.
 */
describe("Free up stops at the cap's line on Base", () => {
  // Holds NVIDIA and backs no credit, as in credit-buy.test.ts (0xcd15…266b, the one before, sold all its stock on 2026-10-15).
  const newcomer = "0xb5ef91ce939f2c390cff462bb231e74bb228deb4";
  const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

  it("its MAX leaves Aave's health at 1.12, in Watch; the old MAX (99.5% of Aave's limit) lands in Act, and the app's check stops it", async () => {
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
    const lockedRaw = BigInt(Math.floor(20 / usdPerRaw));
    expect(free).toBeGreaterThanOrEqual(lockedRaw);
    const lockedUsd = Number(lockedRaw) * usdPerRaw;
    const debtUsd = Math.floor(((lockedUsd * cf) / 1.75) * 1e6) / 1e6;
    // The position, set up first in every simulation below: $20 of NVIDIA in use, credit to a health of 1.75.
    const setup = buildLoanCalls({
      user: newcomer,
      locks: [{ stock: nvda, raw: lockedRaw }],
      borrowRaw: parseUnits(debtUsd.toFixed(6), 6),
    });
    const healthAfter = async (calls: { to: `0x${string}`; data: `0x${string}` }[]) => {
      const read = {
        to: AAVE.SPOKE,
        data: encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [newcomer] }),
      };
      const r = await client.simulateCalls({
        account: newcomer,
        calls: [...setup, ...calls, read].map(({ to, data }) => ({ to, data })),
      });
      expect(r.results.slice(0, setup.length + calls.length).every((x) => x.status === "success")).toBe(true);
      return summarize(
        decodeFunctionResult({
          abi: spokeAbi,
          functionName: "getUserAccountData",
          data: r.results.at(-1)!.data,
        }) as AccountData,
      ).healthFactor!;
    };
    expect(await healthAfter([])).toBeCloseTo(1.75, 3);

    const loan = { collateralUsd: lockedUsd, avgCf: cf, debtUsd, cf, lockedUsd };
    // The sheet's MAX (freeUpCheck), as shares rounded down.
    const sheet = freeUpCheck({
      position: loan,
      holding: { lockedRaw, lockedUsd, priceUsd: priceToUsd(price), multiplier: 10n ** 18n },
      decimals: nvda.decimals,
      cf,
      amountRaw: 0n,
      all: false,
    });
    expect(sheet.maxUsd).toBeCloseTo(maxWithdrawUsd({ ...loan, targetHf: CREDIT_CAP.minHf }), 9);
    const rawFor = (usd: number) => (lockedRaw * BigInt(Math.floor((usd / lockedUsd) * 1e9))) / 1_000_000_000n;
    const maxRaw = rawFor(sheet.maxUsd);
    const oldRaw = rawFor(maxWithdrawUsd(loan) * 0.995);
    const capped = await healthAfter(
      buildWithdrawCalls({ user: newcomer, stock: nvda, amountRaw: maxRaw, all: false }),
    );
    const old = await healthAfter(buildWithdrawCalls({ user: newcomer, stock: nvda, amountRaw: oldRaw, all: false }));
    console.log(
      `Free up NVIDIA from 1.75: MAX $${sheet.maxUsd.toFixed(4)} → health ${capped.toFixed(4)}; old MAX → ${old.toFixed(4)}`,
    );
    expect(statusFor(capped)).toBe("watch");
    expect(capped).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 0.002);
    expect(capped).toBeLessThan(CREDIT_CAP.minHf + 0.01);
    expect(statusFor(old)).toBe("act");

    // The app's own check, as useTx runs it: the batch simulated after the set-up position, Aave's health read after it.
    const deps: CheckDeps = {
      join: async (_u, batch) => batch,
      simulate: async (u, batch) =>
        (
          await client.simulateCalls({ account: u, calls: [...setup, ...batch].map(({ to, data }) => ({ to, data })) })
        ).results.slice(setup.length),
      explain: explainRevert,
    };
    expect(await checkPlan(withdrawPlan({ user: newcomer, stock: nvda, amountRaw: oldRaw, all: false }), deps)).toEqual(
      { ok: false, error: FREE_UP_BLOCKED.act, blocks: true },
    );
    expect(
      (await checkPlan(withdrawPlan({ user: newcomer, stock: nvda, amountRaw: maxRaw, all: false }), deps)).ok,
    ).toBe(true);
  });
});

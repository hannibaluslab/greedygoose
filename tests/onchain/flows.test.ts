/**
 * Simulates the app's real write batches on Base mainnet (eth_simulateV1), from a real
 * Equities Hub borrower. Nothing is signed or sent.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, parseUnits, toFunctionSelector, zeroHash,
} from "viem";
import { CHAIN } from "@/lib/chain";
import { CASH } from "@/config/risk";
import { buildBorrowCalls, buildLoanCalls, buildRepayCalls, buildSupplyCalls, buildWithdrawCalls } from "@/lib/aave/tx";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { AAVE } from "@/lib/aave/addresses";
import { CASH_STUCK, explainRevert } from "@/lib/aave/errors";
import { decodeActivity } from "@/lib/activity/decode";
import { cashRaw, cashShort, payFromCash, readCash, type Cash } from "@/lib/cash";
import { GUARDIAN } from "@/lib/guardian/config";
import { buildWithdrawSavingsCalls } from "@/lib/guardian/permission";
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
      const bal = await client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [user] });
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
    const supplied = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(stock.reserveId), user] });
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
      const bal = await client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [user] });
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
      const bal = await client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [user] });
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
  const walletRead = { to: USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }) };
  const feeBuffer = parseUnits(CASH.feeBufferUsd.toFixed(6), 6);

  const cash = async (): Promise<Cash> => ({
    walletRaw: 0n,
    savingsRaw: await client.readContract({ address: GUARDIAN.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
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
      activity: decodeActivity(r.results.flatMap((x) => x.logs ?? []), user),
    };
  }

  it("the account holds savings, and the override really empties its wallet", async () => {
    const [stored, balance] = await Promise.all([
      client.getStorageAt({ address: USDC.address, slot: walletSlot }),
      client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    ]);
    expect(BigInt(stored ?? 0)).toBe(balance);
    expect(await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user], stateOverride: emptyWallet })).toBe(0n);
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
    expect(calls.map((c) => c.to)).toEqual([GUARDIAN.AAVE_V3_POOL, USDC.address, AERODROME.ROUTER]);
    const r = await simulateFromEmptyWallet(calls);
    expect(r.statuses).toEqual(["success", "success", "success"]);
    expect(r.walletAfter).toBe(feeBuffer);
    // One Activity row: the buy, with the savings withdrawal that paid for it on it, not a move of its own.
    expect(r.activity).toEqual([
      { kind: "buy", symbol: "NVDAc", amount: Number(quote.amountOut) / 1e8, paidUsd: 1, fromSavingsUsd: 1 + CASH.feeBufferUsd },
    ]);
  });

  it("repay $1: withdraw from savings → approve → repay, fee buffer left in the wallet", async () => {
    // A live account: repay $1, or all of it once it owes less (Aave takes no more than is owed).
    const owed = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] });
    expect(owed, "the test account owes nothing to repay").toBeGreaterThan(0n);
    const amountRaw = owed < 1_000_000n ? owed : 1_000_000n;
    const calls = payFromCash(user, amountRaw, await cash(), buildRepayCalls({ user, amountRaw, all: false }));
    expect(calls.map((c) => c.to)).toEqual([GUARDIAN.AAVE_V3_POOL, USDC.address, AAVE.SPOKE]);
    const r = await simulateFromEmptyWallet(calls);
    expect(r.statuses).toEqual(["success", "success", "success"]);
    expect(r.walletAfter).toBe(feeBuffer);
    expect(r.activity).toEqual([
      { kind: "repay", symbol: "USDC", amount: Number(amountRaw) / 1e6, fromSavingsUsd: Number(amountRaw + feeBuffer) / 1e6 },
    ]);
  });

  it("a withdrawal savings can't serve reads as cash that can't move right now", async () => {
    const [withdraw] = buildWithdrawSavingsCalls(user, (await cash()).savingsRaw + 10n ** 12n, false);
    const [r] = (await client.simulateCalls({ account: user, calls: [{ to: withdraw.to, data: withdraw.data }] })).results;
    expect(r.status).toBe("failure");
    expect(r.data).toBe(toFunctionSelector("NotEnoughAvailableUserBalance()"));
    expect(explainRevert(r.data, "fallback", withdraw)).toBe(CASH_STUCK);
  });
});

/** The cash read again right before Face ID (useSigningCash), from the same live account. */
describe("the cash a batch is signed with (readCash)", () => {
  const balance = (token: `0x${string}`) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [user] });

  it("reads what usePosition reads: wallet USDC and savings", async () => {
    const savingsBefore = await balance(GUARDIAN.AUSDC);
    const [c, walletRaw] = await Promise.all([readCash(client, user), balance(USDC.address)]);
    const savingsAfter = await balance(GUARDIAN.AUSDC);
    expect(c.walletRaw).toBe(walletRaw);
    // Savings earn by the second, so the read lands between the two around it.
    expect(c.savingsRaw).toBeGreaterThanOrEqual(savingsBefore);
    expect(c.savingsRaw).toBeLessThanOrEqual(savingsAfter);
    expect(c.saveOn).toBe(false);
  });

  it("a repay built from it simulates, and a spend past it is stopped in words", async () => {
    const c = await readCash(client, user);
    const owed = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] });
    expect(owed, "the test account owes nothing to repay").toBeGreaterThan(0n);
    const amountRaw = owed < 1_000_000n ? owed : 1_000_000n;
    expect(cashShort(amountRaw, c)).toBeNull();
    const r = await simulate(payFromCash(user, amountRaw, c, buildRepayCalls({ user, amountRaw, all: false })));
    expect(r.results.every((x) => x.status === "success")).toBe(true);
    expect(cashShort(cashRaw(c), c)).toMatch(/^Your cash moved since you started\. You have \$[\d,]+\.\d\d now/);
  });
});

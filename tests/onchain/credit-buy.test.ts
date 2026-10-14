/**
 * Simulates Credit Buy batches on Base mainnet (eth_simulateV1), from real accounts. Nothing is
 * signed or sent. Plans come from live reads (Aave's prices, collateral factors and liquidity),
 * quotes from the live pools, the same way the app gets them.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, parseUnits, zeroHash,
  type StateOverride,
} from "viem";
import { CHAIN } from "@/lib/chain";
import { CASH } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { hubAbi } from "@/lib/aave/abis/IHub";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { explainRevert } from "@/lib/aave/errors";
import { priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { swapOf } from "@/lib/allowlist";
import type { Cash } from "@/lib/cash";
import { backingOptions, buildCreditBuyCalls, planCredit, splitCash, type CreditPosition } from "@/lib/creditBuy";
import { GUARDIAN } from "@/lib/guardian/config";
import { buildBuyCalls, minOut, quoteBuy, quotePool, signingQuote, type BuyQuote } from "@/lib/swap/buy";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL), batch: { multicall: true } });
/** Already backs credit: a real Equities Hub borrower with stock collateral and savings (as in flows.test.ts). */
const backer: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
/** Holds all 7 stocks and USDC but has never backed credit (found via the stocks' Transfer logs, 2026-10-14). */
const newcomer: Address = "0xcd1549f523ad3606cc99950c85711c3dbe62266b";
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const feeBuffer = parseUnits(CASH.feeBufferUsd.toFixed(6), 6);
const usd = (n: number) => parseUnits(n.toFixed(6), 6);

/** What usePosition and useCollateralFactors read, for planCredit. */
async function live(user: Address) {
  const [account, liquidity, usdcCfg, walletRaw, savingsRaw] = await Promise.all([
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [user] }),
    client.readContract({ address: AAVE.HUB, abi: hubAbi, functionName: "getAssetLiquidity", args: [BigInt(USDC.reserveId)] }),
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [BigInt(USDC.reserveId)] }),
    client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    client.readContract({ address: GUARDIAN.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
  ]);
  const s = summarize(account as AccountData);
  const position: CreditPosition = {
    ...s,
    usdcLiquidity: Number(liquidity) / 10 ** USDC.decimals,
    borrowPaused: usdcCfg.paused || usdcCfg.frozen || !usdcCfg.borrowable,
  };
  const holdings = await Promise.all(
    EQUITIES.map(async (e) => {
      const id = BigInt(e.reserveId);
      const [freeRaw, price, cfg, reserve] = await Promise.all([
        client.readContract({ address: e.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
        client.readContract({ address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [id] }),
        client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [id] }),
        client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserve", args: [id] }),
      ]);
      const dyn = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getDynamicReserveConfig", args: [id, reserve.dynamicConfigKey] });
      const freeUsd = (Number(freeRaw) / 10 ** e.decimals) * priceToUsd(price);
      return { symbol: e.symbol, freeRaw, freeUsd, paused: cfg.paused, frozen: cfg.frozen, cf: dyn.collateralFactor / 10_000 };
    }),
  );
  const cfs = Object.fromEntries(holdings.map((h) => [h.symbol, h.cf]));
  const cash: Cash = { walletRaw, savingsRaw };
  return { position, options: backingOptions(holdings, cfs), cash };
}

/** The best live quote, read again on its pool the way useSigningQuote does right before Face ID. */
async function quoteToSign(stock: ReserveAsset, amountIn: bigint): Promise<BuyQuote> {
  const shown = await quoteBuy(client, stock, amountIn);
  expect(shown).not.toBeNull();
  const signed = signingQuote(shown!, await quotePool(client, stock, shown!.venue, shown!.pool, amountIn));
  expect(signed).not.toBeNull();
  return signed!;
}

const read = (to: Address, data: Address) => ({ to, data });
const balanceRead = (token: Address, user: Address) => read(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }));
const debtRead = (user: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] }));
const accountRead = (user: Address) => read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [user] }));

/** FiatTokenV2_2 keeps balances in the mapping at slot 9 (checked in flows.test.ts): this empties the wallet. */
const emptyWallet = (user: Address): StateOverride => [
  { address: USDC.address, stateDiff: [{ slot: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, 9n])), value: zeroHash }] },
];

/** Simulates the batch, then reads the stock bought, the debt, the wallet's USDC and the account's health after it. */
async function simulateCreditBuy(user: Address, stock: ReserveAsset, calls: { to: Address; data: Address }[], stateOverrides?: StateOverride) {
  const reads = [balanceRead(stock.address, user), debtRead(user), balanceRead(USDC.address, user), accountRead(user)];
  const before = await client.simulateCalls({ account: user, calls: reads, stateOverrides });
  const r = await client.simulateCalls({ account: user, calls: [...calls, ...reads].map(({ to, data }) => ({ to, data })), stateOverrides });
  const after = r.results.slice(calls.length);
  const uint = (x: { data: Address }) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });
  const hf = (x: { data: Address }) =>
    summarize(decodeFunctionResult({ abi: spokeAbi, functionName: "getUserAccountData", data: x.data }) as AccountData).healthFactor;
  return {
    statuses: r.results.slice(0, calls.length).map((x) => x.status),
    results: r.results,
    stockIn: uint(after[0]) - uint(before.results[0]),
    debtAdded: uint(after[1]) - uint(before.results[1]),
    walletAfter: uint(after[2]),
    hfAfter: hf(after[3]),
  };
}

const swapAmountIn = (calls: { to: Address; data: Address }[]) => swapOf(calls.at(-1)!)!.params.amountIn;

describe("Credit Buy batches simulate on mainnet", () => {
  it("first-time backing: put stock in use → take credit → approve → swap, from an account that never backed credit", async () => {
    const { position, options, cash } = await live(newcomer);
    expect(position.collateralUsd).toBe(0);
    expect(options.length).toBeGreaterThan(0);
    const creditRaw = usd(5);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    expect(plan.before).toBe("none");
    expect(plan.after).toBe("safe");
    expect(plan.backing.length).toBeGreaterThan(0);

    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({ user: newcomer, stock: aapl, quote, creditRaw: plan.creditRaw, backing: plan.backing, cash });
    expect(calls).toHaveLength(plan.backing.length * 3 + 3);
    const r = await simulateCreditBuy(newcomer, aapl, calls);
    console.log(`first-time: backing ${plan.backing.map((b) => `${b.stock.symbol} $${b.usd.toFixed(2)}`).join(", ")}; HF after ${r.hfAfter?.toFixed(3)} (planned ${plan.hfAfter.toFixed(3)})`);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.debtAdded).toBeLessThan(creditRaw + 10n);
    expect(r.stockIn).toBeGreaterThanOrEqual(minOut(quote.amountOut));
    // Aave's health after matches the plan, so the status shown is the status reached.
    expect(r.hfAfter!).toBeGreaterThanOrEqual(1.5);
    expect(r.hfAfter!).toBeCloseTo(plan.hfAfter, 1);
  });

  it("already backing: take credit → approve → swap, the credit spent in full", async () => {
    const { position, options, cash } = await live(backer);
    expect(position.collateralUsd).toBeGreaterThan(0);
    const creditRaw = usd(5);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    expect(plan.backing).toEqual([]);

    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({ user: backer, stock: aapl, quote, creditRaw, backing: plan.backing, cash });
    expect(calls.map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, swapOf(calls[2])!.router]);
    const r = await simulateCreditBuy(backer, aapl, calls);
    expect(r.statuses).toEqual(["success", "success", "success"]);
    expect(swapAmountIn(calls)).toBe(creditRaw);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.stockIn).toBeGreaterThanOrEqual(minOut(quote.amountOut));
    expect(r.walletAfter).toBe(cash.walletRaw); // the credit never stays in the wallet
  });

  it("already backing, $0 wallet: savings pay just the network fee", async () => {
    const { position, options, cash: real } = await live(backer);
    const cash = { walletRaw: 0n, savingsRaw: real.savingsRaw };
    const creditRaw = usd(5);
    const plan = planCredit({ position, options, creditRaw, cash });
    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({ user: backer, stock: aapl, quote, creditRaw, backing: plan.backing, cash });
    expect(calls.map((c) => c.to)).toEqual([GUARDIAN.AAVE_V3_POOL, AAVE.SPOKE, USDC.address, swapOf(calls[3])!.router]);
    const r = await simulateCreditBuy(backer, aapl, calls, emptyWallet(backer));
    expect(r.statuses).toEqual(["success", "success", "success", "success"]);
    expect(r.walletAfter).toBe(feeBuffer);
  });

  it("decision 1, more than your cash: withdraw savings → take credit for the rest → approve → swap", async () => {
    const { position, options, cash: real } = await live(backer);
    // An empty wallet makes savings all of the cash; the buy is $2 more than that.
    const cash = { walletRaw: 0n, savingsRaw: real.savingsRaw };
    const amountIn = cash.savingsRaw + usd(2);
    const { cashRaw, creditRaw } = splitCash(amountIn, cash);
    expect(creditRaw).toBe(usd(2) + feeBuffer);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();

    const quote = await quoteToSign(aapl, amountIn);
    const calls = buildCreditBuyCalls({ user: backer, stock: aapl, quote, creditRaw, backing: plan.backing, cash });
    expect(calls.map((c) => c.to)).toEqual([GUARDIAN.AAVE_V3_POOL, AAVE.SPOKE, USDC.address, swapOf(calls[3])!.router]);
    expect(swapAmountIn(calls)).toBe(cashRaw + creditRaw);
    const r = await simulateCreditBuy(backer, aapl, calls, emptyWallet(backer));
    expect(r.statuses).toEqual(["success", "success", "success", "success"]);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.stockIn).toBeGreaterThanOrEqual(minOut(quote.amountOut));
    // All of savings came out (max uint, with any interest since the read); the fee buffer stays.
    expect(r.walletAfter).toBeGreaterThanOrEqual(feeBuffer);
    expect(r.walletAfter).toBeLessThan(feeBuffer + usd(0.01));
  });

  it("decision 1 on an account that never backed credit: its stock goes in use in the same batch", async () => {
    const { position, options } = await live(newcomer);
    const cash = { walletRaw: usd(3), savingsRaw: 0n }; // $3 of cash, a $10 buy
    const amountIn = usd(10);
    const { cashRaw, creditRaw } = splitCash(amountIn, cash);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.backing.length).toBeGreaterThan(0);
    const quote = await quoteToSign(aapl, amountIn);
    const calls = buildCreditBuyCalls({ user: newcomer, stock: aapl, quote, creditRaw, backing: plan.backing, cash });
    expect(swapAmountIn(calls)).toBe(cashRaw + creditRaw);
    const walletSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [newcomer, 9n]));
    const threeDollars = [{ address: USDC.address, stateDiff: [{ slot: walletSlot, value: encodeAbiParameters([{ type: "uint256" }], [usd(3)]) }] }];
    const r = await simulateCreditBuy(newcomer, aapl, calls, threeDollars);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.walletAfter).toBe(feeBuffer);
    expect(r.hfAfter!).toBeGreaterThanOrEqual(1.5);
  });
});

describe("the swap leg on Base", () => {
  it("a Uniswap buy goes through multicall with its deadline", async () => {
    const amountIn = usd(1);
    const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
    const quote = await quotePool(client, nvda, "uniswap", 3000, amountIn);
    const r = await client.simulateCalls({ account: backer, calls: buildBuyCalls({ user: backer, stock: nvda, quote }).map(({ to, data }) => ({ to, data })) });
    expect(r.results.map((x) => x.status)).toEqual(["success", "success"]);
  });

  it("router reverts read in plain words: past the deadline, and under the floor", async () => {
    const amountIn = usd(1);
    const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
    const uni = await quotePool(client, nvda, "uniswap", 3000, amountIn);
    const late = buildBuyCalls({ user: backer, stock: nvda, quote: uni, nowSec: Math.floor(Date.now() / 1000) - 3_600 });
    const tooLate = (await client.simulateCalls({ account: backer, calls: late.map(({ to, data }) => ({ to, data })) })).results[1];
    expect(tooLate.status).toBe("failure");
    expect(explainRevert(tooLate.data, "fallback", late[1])).toMatch(/took too long/);

    const aero = await quotePool(client, nvda, "aerodrome", 10, amountIn);
    const greedy = buildBuyCalls({ user: backer, stock: nvda, quote: { ...aero, amountOut: aero.amountOut * 2n } });
    const tooLittle = (await client.simulateCalls({ account: backer, calls: greedy.map(({ to, data }) => ({ to, data })) })).results[1];
    expect(tooLittle.status).toBe("failure");
    expect(explainRevert(tooLittle.data, "fallback", greedy[1])).toMatch(/price moved more than 1%/);
  });
});

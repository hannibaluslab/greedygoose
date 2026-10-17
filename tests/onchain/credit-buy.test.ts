/**
 * Simulates Credit Buy batches on Base mainnet (eth_simulateV1), from real accounts. Nothing is
 * signed or sent. Plans come from live reads (Aave's prices, collateral factors and liquidity),
 * quotes from the live pools, the same way the app gets them.
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
  zeroHash,
  type StateOverride,
} from "viem";
import { CHAIN } from "@/lib/chain";
import { CASH, CREDIT_CAP } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { hubAbi } from "@/lib/aave/abis/IHub";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { explainRevert } from "@/lib/aave/errors";
import { priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { buildBackAndCreditCalls } from "@/lib/aave/tx";
import { swapOf } from "@/lib/allowlist";
import type { Cash } from "@/lib/cash";
import {
  CREDIT_BLOCKED,
  backingOptions,
  backingRawFor,
  buildCreditBuyCalls,
  freeShownUsd,
  isAllFree,
  planCredit,
  splitCash,
  type BackingOption,
  type CreditPlan,
  type CreditPosition,
} from "@/lib/creditBuy";
import { creditBuyPlan } from "@/hooks/useCreditBuy";
import { checkPlan, type CheckDeps } from "@/lib/tx/prepared";
import { PROTOCOLS } from "@/lib/protocols/config";
import { statusFor } from "@/lib/risk/status";
import { buildBuyCalls, minOut, quoteBuy, quotePool, signingQuote, type BuyQuote } from "@/lib/swap/buy";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({
  chain: CHAIN,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  batch: { multicall: true },
});
/** Already backs credit: a real Equities Hub borrower with stock collateral and savings (as in flows.test.ts). */
const backer: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
/** Holds all 7 stocks and USDC but backs no credit (found via NVIDIA's Transfer logs, 2026-10-15; 0xcd15…266b, the one before, sold all its stock that day). */
const newcomer: Address = "0xb5ef91ce939f2c390cff462bb231e74bb228deb4";
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const feeBuffer = parseUnits(CASH.feeBufferUsd.toFixed(6), 6);
const usd = (n: number) => parseUnits(n.toFixed(6), 6);

/** What usePosition and useBackingFactors read, for planCredit. */
async function live(user: Address) {
  const [account, liquidity, usdcCfg, walletRaw, savingsRaw] = await Promise.all([
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [user] }),
    client.readContract({
      address: AAVE.HUB,
      abi: hubAbi,
      functionName: "getAssetLiquidity",
      args: [BigInt(USDC.reserveId)],
    }),
    client.readContract({
      address: AAVE.SPOKE,
      abi: spokeAbi,
      functionName: "getReserveConfig",
      args: [BigInt(USDC.reserveId)],
    }),
    client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    client.readContract({ address: PROTOCOLS.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
  ]);
  const s = summarize(account as AccountData);
  const position: CreditPosition = {
    ...s,
    usdcLiquidity: Number(liquidity) / 10 ** USDC.decimals,
    creditPaused: usdcCfg.paused || usdcCfg.frozen || !usdcCfg.borrowable,
  };
  const holdings = await Promise.all(
    EQUITIES.map(async (e) => {
      const id = BigInt(e.reserveId);
      const [freeRaw, price, cfg, reserve] = await Promise.all([
        client.readContract({ address: e.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
        client.readContract({
          address: AAVE.SPOKE_ORACLE,
          abi: aaveOracleAbi,
          functionName: "getReservePrice",
          args: [id],
        }),
        client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [id] }),
        client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserve", args: [id] }),
      ]);
      const dyn = await client.readContract({
        address: AAVE.SPOKE,
        abi: spokeAbi,
        functionName: "getDynamicReserveConfig",
        args: [id, reserve.dynamicConfigKey],
      });
      const freeUsd = (Number(freeRaw) / 10 ** e.decimals) * priceToUsd(price);
      return {
        symbol: e.symbol,
        freeRaw,
        freeUsd,
        paused: cfg.paused,
        frozen: cfg.frozen,
        cf: dyn.collateralFactor / 10_000,
      };
    }),
  );
  const cfs = Object.fromEntries(holdings.map((h) => [h.symbol, h.cf]));
  // No GooseExecutor is deployed yet, so Save is off, as usePosition reads it.
  const cash: Cash = { walletRaw, savingsRaw, saveOn: false };
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
const balanceRead = (token: Address, user: Address) =>
  read(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }));
const debtRead = (user: Address) =>
  read(
    AAVE.SPOKE,
    encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] }),
  );
const accountRead = (user: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [user] }));

/** FiatTokenV2_2 keeps balances in the mapping at slot 9 (checked in flows.test.ts): this empties the wallet. */
const emptyWallet = (user: Address): StateOverride => [
  {
    address: USDC.address,
    stateDiff: [
      { slot: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, 9n])), value: zeroHash },
    ],
  },
];

/** Simulates the batch, then reads the stock bought, the debt, the wallet's USDC and the account's health after it. */
async function simulateCreditBuy(
  user: Address,
  stock: ReserveAsset,
  calls: { to: Address; data: Address }[],
  stateOverrides?: StateOverride,
) {
  const reads = [balanceRead(stock.address, user), debtRead(user), balanceRead(USDC.address, user), accountRead(user)];
  const before = await client.simulateCalls({ account: user, calls: reads, stateOverrides });
  const r = await client.simulateCalls({
    account: user,
    calls: [...calls, ...reads].map(({ to, data }) => ({ to, data })),
    stateOverrides,
  });
  const after = r.results.slice(calls.length);
  const uint = (x: { data: Address }) =>
    decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });
  const hf = (x: { data: Address }) =>
    summarize(decodeFunctionResult({ abi: spokeAbi, functionName: "getUserAccountData", data: x.data }) as AccountData)
      .healthFactor;
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
    expect(position.totalBackingUsd).toBe(0);
    expect(options.length).toBeGreaterThan(0);
    const creditRaw = usd(5);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    expect(plan.before).toBe("none");
    expect(plan.after).toBe("safe");
    expect(plan.backing.length).toBeGreaterThan(0);

    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: newcomer,
      stock: aapl,
      quote,
      creditRaw: plan.creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    expect(calls).toHaveLength(plan.backing.length * 3 + 3);
    const r = await simulateCreditBuy(newcomer, aapl, calls);
    console.log(
      `first-time: backing ${plan.backing.map((b) => `${b.stock.symbol} $${b.usd.toFixed(2)}`).join(", ")}; HF after ${r.hfAfter?.toFixed(3)} (planned ${plan.hfAfter.toFixed(3)})`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.debtAdded).toBeLessThan(creditRaw + 10n);
    expect(r.stockIn).toBeGreaterThanOrEqual(minOut(quote.amountOut));
    // Aave's health after matches the plan, so the status shown is the status reached.
    expect(r.hfAfter!).toBeGreaterThanOrEqual(1.5);
    expect(r.hfAfter!).toBeCloseTo(plan.hfAfter, 1);
  });

  it("the sheet's pick (F2-4): only the holding picked to back it goes in use", async () => {
    const { position, options, cash } = await live(newcomer);
    // CreditBuySheet's default pick: the holding with the most free stock.
    const [picked] = [...options].sort((a, b) => b.freeUsd - a.freeUsd);
    const creditRaw = usd(5);
    const plan = planCredit({ position, options: [picked], creditRaw, cash });
    expect(plan.block).toBeUndefined();
    expect(plan.after).toBe("safe");
    expect(plan.backing.map((b) => b.stock.symbol)).toEqual([picked.stock.symbol]);

    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: newcomer,
      stock: aapl,
      quote,
      creditRaw: plan.creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    const r = await simulateCreditBuy(newcomer, aapl, calls);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.hfAfter!).toBeGreaterThanOrEqual(1.5);
  });

  it("backing first (F2-4 → How much): exactly the typed amount of one free holding goes in use, from the preview account", async () => {
    const { position, options, cash } = await live(backer);
    // The holding with the most free stock that isn't the one bought, as step 1 lists them.
    const option = [...options].filter((o) => o.stock.symbol !== aapl.symbol).sort((a, b) => b.freeUsd - a.freeUsd)[0];
    expect(option).toBeDefined();
    // Half of it, typed in dollars (the preview account keeps a little free: about $1.79 of Amazon on 2026-10-15).
    const typedUsd = Math.floor((option.freeUsd / 2) * 100) / 100;
    const raw = backingRawFor(option, typedUsd);
    expect(raw).toBeGreaterThan(0n);
    expect(raw).toBeLessThan(option.freeRaw);

    const creditRaw = usd(5);
    const room = planCredit({ position, backing: { option, raw }, creditRaw: 0n, cash });
    const plan = planCredit({ position, backing: { option, raw }, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    // Step 2's "You can use up to" is step 4's "Up to", and it grew with the backing.
    expect(plan.maxUsd).toBe(room.maxUsd);
    expect(room.maxUsd).toBeGreaterThan(
      planCredit({ position, backing: { option: null, raw: 0n }, creditRaw: 0n, cash }).maxUsd,
    );
    expect(plan.backing).toEqual([{ stock: option.stock, raw, usd: expect.any(Number) }]);

    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: backer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    const freeBefore = await client.readContract({
      address: option.stock.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [backer],
    });
    const r = await simulateCreditBuy(backer, aapl, [...calls, balanceRead(option.stock.address, backer)]);
    expect(r.statuses.every((x) => x === "success")).toBe(true);
    const freeAfter = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      data: r.results[calls.length].data,
    });
    console.log(
      `backing first: ${option.stock.symbol} $${typedUsd} in use (${raw} raw), up to $${room.maxUsd}; HF after ${r.hfAfter?.toFixed(3)} (planned ${plan.hfAfter.toFixed(3)})`,
    );
    // Exactly the typed backing left the wallet: not the planner's auto amount.
    expect(freeBefore - freeAfter).toBe(raw);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.debtAdded).toBeLessThan(creditRaw + 10n);
    expect(r.stockIn).toBeGreaterThanOrEqual(minOut(quote.amountOut));
    expect(r.hfAfter!).toBeCloseTo(plan.hfAfter, 1);
  });

  it("backing first on an account that never backed credit: the credit is capped by the typed backing alone", async () => {
    const { position, options, cash } = await live(newcomer);
    const option = options.find((o) => o.stock.symbol === "NVDAc")!;
    expect(option.freeUsd).toBeGreaterThan(20);
    const raw = backingRawFor(option, 20);
    const room = planCredit({ position, backing: { option, raw }, creditRaw: 0n, cash });
    // $20 of NVIDIA at its collateral factor, over the cap's line (1.12): nothing else backs this account's credit.
    expect(room.maxUsd).toBeLessThanOrEqual((20 * option.cf) / CREDIT_CAP.minHf);
    expect(room.maxUsd).toBeGreaterThan((20 * option.cf) / CREDIT_CAP.minHf - 0.02);
    expect(planCredit({ position, backing: { option, raw }, creditRaw: usd(room.maxUsd + 0.01), cash }).block).toBe(
      "too-much",
    );

    const creditRaw = usd(5);
    const plan = planCredit({ position, backing: { option, raw }, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    expect(plan.after).toBe("safe");
    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: newcomer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    const r = await simulateCreditBuy(newcomer, aapl, [...calls, balanceRead(option.stock.address, newcomer)]);
    expect(r.statuses.every((x) => x === "success")).toBe(true);
    const freeAfter = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      data: r.results[calls.length].data,
    });
    expect(option.freeRaw - freeAfter).toBe(raw);
    expect(r.hfAfter!).toBeCloseTo(plan.hfAfter, 1);
  });

  it("backing first with MAX: all the free shares go in use, and none are left behind", async () => {
    const { position, options, cash } = await live(backer);
    const option: BackingOption = [...options]
      .filter((o) => o.stock.symbol !== aapl.symbol)
      .sort((a, b) => b.freeUsd - a.freeUsd)[0];
    expect(option).toBeDefined();
    const creditRaw = usd(5);
    const plan = planCredit({ position, backing: { option, raw: option.freeRaw }, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: backer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    const r = await simulateCreditBuy(backer, aapl, [...calls, balanceRead(option.stock.address, backer)]);
    expect(r.statuses.every((x) => x === "success")).toBe(true);
    expect(decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.results[calls.length].data })).toBe(
      0n,
    );
  });

  it("backing first with the free value typed by hand (MAX's figure): it's all of it, and none are left behind", async () => {
    const { position, options, cash } = await live(backer);
    const option: BackingOption = [...options]
      .filter((o) => o.stock.symbol !== aapl.symbol)
      .sort((a, b) => b.freeUsd - a.freeUsd)[0];
    expect(option).toBeDefined();
    const typedUsd = freeShownUsd(option);
    expect(isAllFree(option, typedUsd)).toBe(true);
    const raw = backingRawFor(option, typedUsd);
    expect(raw).toBe(option.freeRaw);
    const creditRaw = usd(5);
    const plan = planCredit({ position, backing: { option, raw }, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: backer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    const r = await simulateCreditBuy(backer, aapl, [...calls, balanceRead(option.stock.address, backer)]);
    expect(r.statuses.every((x) => x === "success")).toBe(true);
    expect(decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.results[calls.length].data })).toBe(
      0n,
    );
  });

  it("backing first with nothing new: only what already backs credit, take credit → approve → swap", async () => {
    const { position, options, cash } = await live(backer);
    const plan = planCredit({ position, backing: { option: options[0] ?? null, raw: 0n }, creditRaw: usd(5), cash });
    expect(plan.block).toBeUndefined();
    expect(plan.backing).toEqual([]);
    const quote = await quoteToSign(aapl, usd(5));
    const calls = buildCreditBuyCalls({
      user: backer,
      stock: aapl,
      quote,
      creditRaw: usd(5),
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    expect(calls.map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, swapOf(calls[2])!.router]);
    const r = await simulateCreditBuy(backer, aapl, calls);
    expect(r.statuses).toEqual(["success", "success", "success"]);
  });

  it("already backing: take credit → approve → swap, the credit spent in full", async () => {
    const { position, options, cash } = await live(backer);
    expect(position.totalBackingUsd).toBeGreaterThan(0);
    const creditRaw = usd(5);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    expect(plan.backing).toEqual([]);

    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: backer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
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
    const cash = { ...real, walletRaw: 0n };
    const creditRaw = usd(5);
    const plan = planCredit({ position, options, creditRaw, cash });
    const quote = await quoteToSign(aapl, creditRaw);
    const calls = buildCreditBuyCalls({
      user: backer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    expect(calls.map((c) => c.to)).toEqual([
      PROTOCOLS.AAVE_V3_POOL,
      AAVE.SPOKE,
      USDC.address,
      swapOf(calls[3])!.router,
    ]);
    const r = await simulateCreditBuy(backer, aapl, calls, emptyWallet(backer));
    expect(r.statuses).toEqual(["success", "success", "success", "success"]);
    expect(r.walletAfter).toBe(feeBuffer);
  });

  it("decision 1, more than your cash: withdraw savings → take credit for the rest → approve → swap", async () => {
    const { position, options, cash: real } = await live(backer);
    // An empty wallet makes savings all of the cash; the buy is $2 more than that.
    const cash = { ...real, walletRaw: 0n };
    const amountIn = cash.savingsRaw + usd(2);
    const { cashRaw, creditRaw } = splitCash(amountIn, cash);
    expect(creditRaw).toBe(usd(2) + feeBuffer);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();

    const quote = await quoteToSign(aapl, amountIn);
    const calls = buildCreditBuyCalls({
      user: backer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    expect(calls.map((c) => c.to)).toEqual([
      PROTOCOLS.AAVE_V3_POOL,
      AAVE.SPOKE,
      USDC.address,
      swapOf(calls[3])!.router,
    ]);
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
    const cash: Cash = { walletRaw: usd(3), savingsRaw: 0n, saveOn: false }; // $3 of cash, a $10 buy
    const amountIn = usd(10);
    const { cashRaw, creditRaw } = splitCash(amountIn, cash);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.backing.length).toBeGreaterThan(0);
    const quote = await quoteToSign(aapl, amountIn);
    const calls = buildCreditBuyCalls({
      user: newcomer,
      stock: aapl,
      quote,
      creditRaw,
      backing: plan.backing,
      limit: plan.limit,
      cash,
    });
    expect(swapAmountIn(calls)).toBe(cashRaw + creditRaw);
    const walletSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [newcomer, 9n]));
    const threeDollars = [
      {
        address: USDC.address,
        stateDiff: [{ slot: walletSlot, value: encodeAbiParameters([{ type: "uint256" }], [usd(3)]) }],
      },
    ];
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
    const r = await client.simulateCalls({
      account: backer,
      calls: buildBuyCalls({ user: backer, stock: nvda, quote }).map(({ to, data }) => ({ to, data })),
    });
    expect(r.results.map((x) => x.status)).toEqual(["success", "success"]);
  });

  it("router reverts read in plain words: past the deadline, and under the floor", async () => {
    const amountIn = usd(1);
    const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
    const uni = await quotePool(client, nvda, "uniswap", 3000, amountIn);
    const late = buildBuyCalls({
      user: backer,
      stock: nvda,
      quote: uni,
      nowSec: Math.floor(Date.now() / 1000) - 3_600,
    });
    const tooLate = (await client.simulateCalls({ account: backer, calls: late.map(({ to, data }) => ({ to, data })) }))
      .results[1];
    expect(tooLate.status).toBe("failure");
    expect(explainRevert(tooLate.data, "fallback", late[1])).toMatch(/took too long/);

    const aero = await quotePool(client, nvda, "aerodrome", 10, amountIn);
    const greedy = buildBuyCalls({ user: backer, stock: nvda, quote: { ...aero, amountOut: aero.amountOut * 2n } });
    const tooLittle = (
      await client.simulateCalls({ account: backer, calls: greedy.map(({ to, data }) => ({ to, data })) })
    ).results[1];
    expect(tooLittle.status).toBe("failure");
    expect(explainRevert(tooLittle.data, "fallback", greedy[1])).toMatch(/price moved more than 1%/);
  });
});

/** The account's position read back from a simulation (the accountRead after a batch), as planCredit reads it. */
const positionAfter = (data: Address, base: CreditPosition): CreditPosition => ({
  ...base,
  ...summarize(decodeFunctionResult({ abi: spokeAbi, functionName: "getUserAccountData", data }) as AccountData),
});

describe("Act is the line on Base (Adrian, 2026-10-15)", () => {
  it("what 99.5% of Aave's limit allowed ends in Act on Aave's own health; the plan now blocks it, and the cap ends in Watch", async () => {
    const { position, options, cash } = await live(newcomer);
    const option = options.find((o) => o.stock.symbol === "NVDAc")!;
    const raw = backingRawFor(option, 20);
    const pick = { option, raw };
    const usdIn = option.freeUsd * (Number(raw) / Number(option.freeRaw));
    const oldMax = Math.floor(usdIn * option.cf * 0.995 * 100) / 100;
    const cap = planCredit({ position, backing: pick, creditRaw: 0n, cash }).maxUsd;
    expect(cap).toBeLessThan(oldMax);
    expect(planCredit({ position, backing: pick, creditRaw: usd(oldMax), cash }).block).toBe("act");

    const healthWith = async (creditUsd: number) => {
      const calls = buildBackAndCreditCalls({
        user: newcomer,
        backing: [{ stock: option.stock, raw }],
        creditRaw: usd(creditUsd),
      });
      const r = await client.simulateCalls({ account: newcomer, calls: [...calls, accountRead(newcomer)] });
      expect(r.results.map((x) => x.status).every((x) => x === "success")).toBe(true);
      return positionAfter(r.results[calls.length].data, position).healthFactor!;
    };
    const old = await healthWith(oldMax);
    const capped = await healthWith(cap);
    console.log(
      `$20 of NVIDIA: old MAX $${oldMax} → health ${old.toFixed(4)}; cap $${cap} → health ${capped.toFixed(4)}`,
    );
    expect(statusFor(old)).toBe("act");
    expect(statusFor(capped)).toBe("watch");
    expect(capped).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 0.002);
    expect(capped).toBeLessThan(CREDIT_CAP.minHf + 0.01);
  });

  it("the app's own check reads Aave's health after the batch: credit that lands in Act stops there, whatever the screen planned", async () => {
    const { position, options, cash } = await live(newcomer);
    const option = options.find((o) => o.stock.symbol === "NVDAc")!;
    const raw = backingRawFor(option, 20);
    const pick = { option, raw };
    const usdIn = option.freeUsd * (Number(raw) / Number(option.freeRaw));
    const oldMax = Math.floor(usdIn * option.cf * 0.995 * 100) / 100;
    // As useTx checks a batch: eth_simulateV1 from the account, with Aave's health read after it.
    const deps: CheckDeps = {
      join: async (_u, batch) => batch,
      simulate: async (u, batch) =>
        (await client.simulateCalls({ account: u, calls: batch.map(({ to, data }) => ({ to, data })) })).results,
      explain: explainRevert,
    };
    // A Credit Buy planned on a stale reading (its screen thought the old MAX ended in Watch): Aave's health stops it.
    const shown = planCredit({ position, backing: pick, creditRaw: usd(oldMax), cash });
    const stale: CreditPlan = {
      ...shown,
      block: undefined,
      after: "watch",
      extraConfirm: true,
      limit: { ...shown.limit, maxCreditRaw: usd(oldMax) },
    };
    const quote = await quoteToSign(option.stock, stale.creditRaw);
    const buy = creditBuyPlan(
      { user: newcomer, stock: option.stock, quote, plan: stale, confirmedRisk: true },
      async (p) =>
        buildCreditBuyCalls({
          user: p.user,
          stock: p.stock,
          quote: p.quote,
          creditRaw: p.plan.creditRaw,
          backing: p.plan.backing,
          limit: p.plan.limit,
          cash,
        }),
    );
    expect(await checkPlan(buy, deps)).toEqual({ ok: false, error: CREDIT_BLOCKED.act, blocks: true });
  });

  it("the leverage loop: two Credit Buys at MAX, the second backed by the NVIDIA the first one bought, end at the cap's line in Watch", async () => {
    const { position, options, cash } = await live(newcomer);
    const option = options.find((o) => o.stock.symbol === "NVDAc")!;
    const nvda = option.stock;
    const usdPerRaw = option.freeUsd / Number(option.freeRaw);

    // 1: $20 of NVIDIA in use, the MAX in credit, NVIDIA bought with it.
    const pick1 = { option, raw: backingRawFor(option, 20) };
    const max1 = planCredit({ position, backing: pick1, creditRaw: 0n, cash }).maxUsd;
    const plan1 = planCredit({ position, backing: pick1, creditRaw: usd(max1), cash });
    expect(plan1).toMatchObject({ after: "watch", block: undefined, extraConfirm: true });
    const quote1 = await quoteToSign(nvda, plan1.creditRaw);
    const calls1 = buildCreditBuyCalls({
      user: newcomer,
      stock: nvda,
      quote: quote1,
      creditRaw: plan1.creditRaw,
      backing: plan1.backing,
      limit: plan1.limit,
      cash,
    });
    const r1 = await simulateCreditBuy(newcomer, nvda, calls1);
    expect(r1.statuses.every((x) => x === "success")).toBe(true);
    expect(statusFor(r1.hfAfter)).toBe("watch");
    expect(r1.hfAfter!).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 0.002);

    // 2: what it bought goes in use, and the MAX again, planned on the position after 1 as the app would read it.
    const after1 = positionAfter(r1.results[calls1.length + 3].data, position);
    // The wallet's NVIDIA moved by what was bought less what went in use (the same stock).
    const boughtRaw = r1.stockIn + pick1.raw;
    expect(boughtRaw).toBeGreaterThanOrEqual(minOut(quote1.amountOut));
    const bought: BackingOption = {
      stock: nvda,
      freeRaw: boughtRaw,
      freeUsd: Number(boughtRaw) * usdPerRaw,
      cf: option.cf,
    };
    const pick2 = { option: bought, raw: bought.freeRaw };
    const max2 = planCredit({ position: after1, backing: pick2, creditRaw: 0n, cash }).maxUsd;
    expect(max2).toBeLessThan(max1); // each round is about cf ÷ 1.12 of the last
    expect(max2).toBeGreaterThanOrEqual(1);
    const plan2 = planCredit({ position: after1, backing: pick2, creditRaw: usd(max2), cash });
    expect(plan2).toMatchObject({ after: "watch", block: undefined });
    expect(planCredit({ position: after1, backing: pick2, creditRaw: usd(max2 * 1.05), cash }).block).toMatch(
      /too-much|act/,
    );
    const quote2 = await quoteToSign(nvda, plan2.creditRaw);
    const calls2 = buildCreditBuyCalls({
      user: newcomer,
      stock: nvda,
      quote: quote2,
      creditRaw: plan2.creditRaw,
      backing: plan2.backing,
      limit: plan2.limit,
      cash,
    });
    const r2 = await simulateCreditBuy(newcomer, nvda, [...calls1, ...calls2]);
    console.log(`leverage loop: $${max1} then $${max2}; health ${r1.hfAfter?.toFixed(4)} → ${r2.hfAfter?.toFixed(4)}`);
    expect(r2.statuses.every((x) => x === "success")).toBe(true);
    expect(statusFor(r2.hfAfter)).toBe("watch");
    expect(r2.hfAfter!).toBeGreaterThanOrEqual(CREDIT_CAP.minHf - 0.003);
    expect(r2.hfAfter!).toBeLessThan(CREDIT_CAP.minHf + 0.01);
  });
});

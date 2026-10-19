import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import {
  buildCreditCalls,
  buildBackAndCreditCalls,
  buildRepayCalls,
  buildSupplyCalls,
  buildWithdrawCalls,
} from "@/lib/aave/tx";
import { payFromCash, type Cash } from "@/lib/cash";
import { buildEarnCalls } from "@/lib/earnWithStocks";
import { buildSendCalls } from "@/lib/send";
import { buildTradeCalls } from "@/lib/trade";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { buildAddSavingsCalls, buildWithdrawSavingsCalls } from "@/lib/savings";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { AAVE } from "@/lib/aave/addresses";
import { swapRouter02Abi } from "@/lib/swap/abis";
import { UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

const user = "0x000000000000000000000000000000000000dEaD";
const attacker = "0x00000000000000000000000000000000000000ee";
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const quote: BuyQuote = { venue: "uniswap", pool: 3000, amountIn: 1_000_000n, amountOut: 295_545n };
const approve = (token: `0x${string}`, spender: `0x${string}`, amount = 1n) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  value: 0n,
});
const exactInputSingle = (tokenOut: `0x${string}`, recipient: `0x${string}`) =>
  encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC.address,
        tokenOut,
        fee: 3000,
        recipient,
        amountIn: 1n,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
const multicall = (data: `0x${string}`[]) => ({
  to: UNISWAP.SWAP_ROUTER_02,
  data: encodeFunctionData({ abi: swapRouter02Abi, functionName: "multicall", args: [1_600n, data] }),
  value: 0n,
});
const swap = (tokenOut: `0x${string}`, recipient: `0x${string}`) => multicall([exactInputSingle(tokenOut, recipient)]);

describe("assertAllowed (one allowlist for every user batch)", () => {
  it("passes what the builders make, savings withdrawals included", () => {
    const batch = [
      ...buildWithdrawSavingsCalls(user, 1_500_000n, false),
      ...buildWithdrawSavingsCalls(user, 0n, true),
      ...buildBuyCalls({ user, stock: nvda, quote, oraclePriceUsd: 336 }),
      ...buildBuyCalls({ user, stock: nvda, quote: { ...quote, venue: "aerodrome", pool: 10 }, oraclePriceUsd: 336 }),
      ...buildRepayCalls({ user, amountRaw: 1_000_000n }),
      ...buildSupplyCalls({ user, stock: nvda, amountRaw: 1n }),
      ...buildWithdrawCalls({ user, stock: nvda, amountRaw: 1n, all: false }),
      ...buildCreditCalls({ user, amountRaw: 1n }),
    ];
    expect(assertAllowed(user, batch)).toBe(batch);
  });

  it("blocks unknown targets and any value", () => {
    expect(() => assertAllowed(user, [{ to: attacker, data: "0x", value: 0n }])).toThrow(/unexpected target/);
    const [w] = buildWithdrawSavingsCalls(user, 1n, false);
    expect(() => assertAllowed(user, [{ ...w, value: 1n }])).toThrow(/unexpected value/);
  });

  it("holds each target to its own functions", () => {
    // Buys and repays only take savings out; putting them in is not part of these batches.
    const supply = buildAddSavingsCalls(user, 1n)[1];
    expect(() => assertAllowed(user, [supply])).toThrow(/unexpected call/);
    const transfer = {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, 1n] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [transfer])).toThrow(/unexpected call/);
    const poolTransfer = { ...transfer, to: PROTOCOLS.AAVE_V3_POOL };
    expect(() => assertAllowed(user, [poolTransfer])).toThrow(/unexpected call/);
    const withdrawOnRouter = {
      to: UNISWAP.SWAP_ROUTER_02,
      data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "withdraw", args: [USDC.address, 1n, user] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [withdrawOnRouter])).toThrow(/unexpected call/);
  });

  it("approves only the spoke and the routers", () => {
    expect(() =>
      assertAllowed(user, [approve(USDC.address, AAVE.SPOKE), approve(nvda.address, UNISWAP.SWAP_ROUTER_02)]),
    ).not.toThrow();
    expect(() => assertAllowed(user, [approve(USDC.address, attacker)])).toThrow(/unexpected spender/);
    expect(() => assertAllowed(user, [approve(USDC.address, PROTOCOLS.AAVE_V3_POOL)])).toThrow(/unexpected spender/);
  });

  it("refuses an unlimited approve on every approve rule: max uint, and anything from 2^128 up", () => {
    const unlimited = [maxUint256, 2n ** 128n];
    for (const amount of unlimited) {
      expect(() => assertAllowed(user, [approve(USDC.address, AAVE.SPOKE, amount)])).toThrow(/unexpected/);
      expect(() => assertAllowed(user, [approve(nvda.address, UNISWAP.SWAP_ROUTER_02, amount)])).toThrow(/unexpected/);
      for (const coin of ENTRY_COINS) {
        const venue = coin.venue.kind === "psm3" ? coin.venue.psm : coin.venue.router;
        expect(() => assertAllowed(user, [approve(coin.address, venue, amount)])).toThrow(/unexpected/);
      }
      // A savings supply of that much, approved for exactly that much, is just as unlimited.
      expect(() =>
        assertAllowed(
          user,
          [
            approve(USDC.address, PROTOCOLS.AAVE_V3_POOL, amount),
            {
              to: PROTOCOLS.AAVE_V3_POOL,
              data: encodeFunctionData({
                abi: aaveV3PoolAbi,
                functionName: "supply",
                args: [USDC.address, amount, user, 0],
              }),
              value: 0n,
            },
          ],
          { saveTo: user },
        ),
      ).toThrow(/unexpected/);
    }
    // Just under the line, as any real balance is, still passes.
    expect(() => assertAllowed(user, [approve(USDC.address, AAVE.SPOKE, 2n ** 128n - 1n)])).not.toThrow();
    const [coin] = ENTRY_COINS;
    const venue = coin.venue.kind === "psm3" ? coin.venue.psm : coin.venue.router;
    expect(() => assertAllowed(user, [approve(coin.address, venue, 10n ** 24n)])).not.toThrow();
  });

  it("keeps the money with the user: every withdrawal, position and swap is the user's own", () => {
    // Each builder is valid for its own account; checked against `user`, the other account's batch is refused.
    const other = [
      buildWithdrawSavingsCalls(attacker, 1n, false),
      buildBuyCalls({ user: attacker, stock: nvda, quote, oraclePriceUsd: 336 }),
      buildRepayCalls({ user: attacker, amountRaw: 1n }),
      buildSupplyCalls({ user: attacker, stock: nvda, amountRaw: 1n }),
      buildWithdrawCalls({ user: attacker, stock: nvda, amountRaw: 1n, all: false }),
      buildCreditCalls({ user: attacker, amountRaw: 1n }),
    ];
    for (const batch of other) expect(() => assertAllowed(user, batch)).toThrow(/unexpected arguments/);
  });

  it("takes only USDC out of savings, and swaps only between registry tokens", () => {
    const withdrawStock = {
      to: PROTOCOLS.AAVE_V3_POOL,
      data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "withdraw", args: [nvda.address, 1n, user] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [withdrawStock])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [swap(nvda.address, user)])).not.toThrow();
    expect(() => assertAllowed(user, [swap(attacker, user)])).toThrow(/unexpected arguments/);
  });

  it("takes Uniswap swaps only with their deadline, one swap per multicall", () => {
    const bare = { to: UNISWAP.SWAP_ROUTER_02, data: exactInputSingle(nvda.address, user), value: 0n };
    expect(() => assertAllowed(user, [bare])).toThrow(/unexpected call/);
    expect(() => assertAllowed(user, [multicall([exactInputSingle(nvda.address, attacker)])])).toThrow(
      /unexpected arguments/,
    );
    expect(() =>
      assertAllowed(user, [multicall([exactInputSingle(nvda.address, user), exactInputSingle(nvda.address, user)])]),
    ).toThrow(/unexpected arguments/);
    const nested = multicall([multicall([exactInputSingle(nvda.address, user)]).data]);
    expect(() => assertAllowed(user, [nested])).toThrow(/unexpected arguments/);
    const transferInside = multicall([
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, 1n] }),
    ]);
    expect(() => assertAllowed(user, [transferInside])).toThrow(/unexpected arguments/);
  });
});

describe("assertAllowed: Earn with stocks' savings supply (saveTo)", () => {
  const amount = 500_000_000n;
  const save = (who: `0x${string}` = user, raw = amount) => buildAddSavingsCalls(who, raw);
  const supplyOf = (asset: `0x${string}`, onBehalfOf: `0x${string}`, raw: bigint, referral = 0) => ({
    to: PROTOCOLS.AAVE_V3_POOL,
    data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "supply", args: [asset, raw, onBehalfOf, referral] }),
    value: 0n,
  });
  const approveSave = (raw: bigint) => ({
    to: USDC.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PROTOCOLS.AAVE_V3_POOL, raw] }),
    value: 0n,
  });
  const backAndCredit = buildBackAndCreditCalls({
    user,
    backing: [{ stock: nvda, raw: 1_000_000n }],
    creditRaw: amount,
  });
  const cash: Cash = { walletRaw: 40_000_000n, savingsRaw: 0n, saveOn: false };

  it("passes Earn with stocks' batch: stock in use, credit, then an exact approve and a USDC supply for the user", () => {
    const batch = [...backAndCredit, ...save()];
    expect(assertAllowed(user, batch, { saveTo: user })).toBe(batch);
    const limit = { maxCreditRaw: amount, freeRaw: { NVDAc: 1_000_000n } };
    expect(
      buildEarnCalls({ user, backing: [{ stock: nvda, raw: 1_000_000n }], creditRaw: amount, limit, cash }),
    ).toHaveLength(6);
  });

  it("refuses a savings supply in every batch that doesn't declare it, as before", () => {
    // Alone, and in each other flow's batch as its builder hands it to the allowlist.
    expect(() => assertAllowed(user, save())).toThrow(/unexpected (call|spender)/);
    expect(() => assertAllowed(user, [save()[1]])).toThrow(/unexpected call/);
    const buy = buildBuyCalls({ user, stock: nvda, quote, oraclePriceUsd: 336 });
    expect(() => assertAllowed(user, [...buy, ...save()])).toThrow(/unexpected/);
    expect(() => payFromCash(user, quote.amountIn, cash, [...buy, ...save()])).toThrow(/unexpected/);
    const creditBuy = [
      ...backAndCredit,
      ...buildBuyCalls({ user, stock: nvda, quote: { ...quote, amountIn: amount }, oraclePriceUsd: 336 }),
    ];
    expect(() => payFromCash(user, 0n, cash, [...creditBuy, ...save()])).toThrow(/unexpected/);
    const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
    const trade = buildTradeCalls({
      user,
      from: nvda,
      to: aapl,
      sellQuote: { venue: "aerodrome", pool: 10, amountIn: 100_000_000n, amountOut: 200_000_000n },
      buyQuote: { venue: "uniswap", pool: 3000, amountIn: 150_000_000n, amountOut: 1n },
      oraclePriceUsd: 200,
      toPriceUsd: 300,
      nowSec: 1_000,
    });
    expect(() => assertAllowed(user, [...trade, ...save()])).toThrow(/unexpected/);
    const send = buildSendCalls({ user, token: USDC, to: attacker, amountRaw: 1_000_000n, cash });
    expect(() => assertAllowed(user, [...send, ...save()], { sendTo: attacker })).toThrow(/unexpected/);
    // Without the supply, the approve to the pool is no spender either.
    expect(() => assertAllowed(user, [approveSave(amount)], { saveTo: user })).toThrow(/unexpected spender/);
  });

  it("saves only for the user, only USDC, referral code 0, more than 0, no value", () => {
    expect(() => assertAllowed(user, [...backAndCredit, ...save()], { saveTo: attacker })).toThrow(/only for the user/);
    expect(() =>
      assertAllowed(user, [...backAndCredit, approveSave(amount), supplyOf(USDC.address, attacker, amount)], {
        saveTo: user,
      }),
    ).toThrow(/unexpected arguments to supply/);
    expect(() =>
      assertAllowed(user, [...backAndCredit, approveSave(amount), supplyOf(nvda.address, user, amount)], {
        saveTo: user,
      }),
    ).toThrow(/unexpected arguments to supply/);
    expect(() =>
      assertAllowed(user, [...backAndCredit, approveSave(amount), supplyOf(USDC.address, user, amount, 1)], {
        saveTo: user,
      }),
    ).toThrow(/unexpected arguments to supply/);
    expect(() =>
      assertAllowed(user, [...backAndCredit, approveSave(0n), supplyOf(USDC.address, user, 0n)], { saveTo: user }),
    ).toThrow(/unexpected arguments to supply/);
    const [a, sup] = save();
    expect(() => assertAllowed(user, [...backAndCredit, a, { ...sup, value: 1n }], { saveTo: user })).toThrow(
      /unexpected value/,
    );
    // Another account's batch, checked against the user.
    expect(() => assertAllowed(user, [...save(attacker)], { saveTo: user })).toThrow(/unexpected arguments to supply/);
  });

  it("approves the pool for exactly the one supply, once", () => {
    expect(() =>
      assertAllowed(user, [...backAndCredit, approveSave(amount + 1n), supplyOf(USDC.address, user, amount)], {
        saveTo: user,
      }),
    ).toThrow(/unexpected spender/);
    expect(() =>
      assertAllowed(user, [...backAndCredit, approveSave(amount - 1n), supplyOf(USDC.address, user, amount)], {
        saveTo: user,
      }),
    ).toThrow(/unexpected spender/);
    expect(() =>
      assertAllowed(
        user,
        [...backAndCredit, approveSave(amount), approveSave(amount), supplyOf(USDC.address, user, amount)],
        {
          saveTo: user,
        },
      ),
    ).toThrow(/more than one savings approval/);
    expect(() => assertAllowed(user, [...backAndCredit, ...save(), ...save()], { saveTo: user })).toThrow(
      /more than one savings supply/,
    );
    // A stock approved to the pool is no spender, even in this batch.
    const stockToPool = {
      to: nvda.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PROTOCOLS.AAVE_V3_POOL, amount] }),
      value: 0n,
    };
    expect(() =>
      assertAllowed(user, [...backAndCredit, stockToPool, supplyOf(USDC.address, user, amount)], { saveTo: user }),
    ).toThrow(/unexpected spender/);
  });

  it("leaves Send's one transfer as it was: saveTo doesn't open transfers", () => {
    const transfer = {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, 1n] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [...backAndCredit, ...save(), transfer], { saveTo: user })).toThrow(
      /unexpected call/,
    );
  });
});

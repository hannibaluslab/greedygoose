/**
 * Simulates the Trade sheet's stock → stock batch on Base mainnet (eth_simulateV1), from real accounts. Nothing is
 * signed or sent. Quotes come from the live pools and are read again on their pools the way useSigningQuote reads
 * them right before JAW's sheet; the buy is sized from the sale's floor as the sheet sizes it (swapBuyInRaw).
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, erc20Abi, http, parseUnits, type Log } from "viem";
import { CHAIN } from "@/lib/chain";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { priceToUsd } from "@/lib/aave/math";
import type { Call } from "@/lib/aave/tx";
import { decodeActivity } from "@/lib/activity/decode";
import { feeBufferRaw, payFromCash, readCash, type Cash } from "@/lib/cash";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { minOut, quotePool, quoteSwap, signingQuote, type BuyQuote, type Side } from "@/lib/swap/buy";
import { sellMinOut } from "@/lib/swap/sell";
import { buildTradeCalls, sharesForUsdRaw, swapBuyInRaw } from "@/lib/trade";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL), batch: { multicall: true } });
/** Backs credit with five stocks (as in sell.test.ts), and holds a little free AMZN. */
const backer: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
/** Holds all 7 stocks free and has never backed credit. */
const newcomer: Address = "0xcd1549f523ad3606cc99950c85711c3dbe62266b";
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const amzn = EQUITIES.find((e) => e.symbol === "AMZNc")!;

const plain = (calls: { to: Address; data: Address }[]) => calls.map(({ to, data }) => ({ to, data }));
const read = (to: Address, data: Address) => ({ to, data });
const balanceRead = (token: Address, user: Address) => read(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }));
const suppliedRead = (stock: ReserveAsset, user: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(stock.reserveId), user] }));
const debtRead = (user: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] }));
const uint = (x: { data: Address }) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });

/** Aave's price for a stock, as usePosition reads it. */
const priceOf = async (stock: ReserveAsset) =>
  priceToUsd(await client.readContract({ address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [BigInt(stock.reserveId)] }));
const priceRawOf = (stock: ReserveAsset) =>
  client.readContract({ address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [BigInt(stock.reserveId)] });

/** The best live quote, read again on its pool the way useSigningQuote does right before JAW's sheet. */
async function quoteToSign(stock: ReserveAsset, amountIn: bigint, side: Side): Promise<BuyQuote> {
  const shown = await quoteSwap(client, stock, amountIn, side);
  expect(shown).not.toBeNull();
  const signed = signingQuote(shown!, await quotePool(client, stock, shown!.venue, shown!.pool, amountIn, side));
  expect(signed).not.toBeNull();
  return signed!;
}

/** The trade as the sheet builds it for `sharesRaw` of `from` into `to`, with the cash `cash`. */
async function trade(user: Address, from: ReserveAsset, to: ReserveAsset, sharesRaw: bigint, cash: Cash) {
  const oraclePriceUsd = await priceOf(from);
  const sellQuote = await quoteToSign(from, sharesRaw, "sell");
  const floor = sellMinOut(sellQuote, from, oraclePriceUsd);
  const buyIn = swapBuyInRaw(floor, cash);
  const buyQuote = await quoteToSign(to, buyIn, "buy");
  expect(buyQuote.amountIn).toBe(buyIn);
  const calls = buildTradeCalls({ user, from, to, sellQuote, buyQuote, oraclePriceUsd });
  return { oraclePriceUsd, sellQuote, floor, buyIn, buyQuote, calls };
}

/** Simulates `before`, then the batch, and reads the account around the batch. */
async function simulate(user: Address, from: ReserveAsset, to: ReserveAsset, calls: Call[], before: Call[] = []) {
  const reads = [balanceRead(from.address, user), balanceRead(to.address, user), balanceRead(USDC.address, user), suppliedRead(from, user), debtRead(user)];
  const r = await client.simulateCalls({ account: user, calls: [...plain(before), ...reads, ...plain(calls), ...reads] });
  const batch = r.results.slice(before.length + reads.length, before.length + reads.length + calls.length);
  const [a, b] = [r.results.slice(before.length, before.length + reads.length), r.results.slice(-reads.length)];
  const ok = batch.every((x) => x.status === "success");
  const delta = (i: number) => (ok ? uint(b[i]) - uint(a[i]) : 0n);
  return {
    statuses: batch.map((x) => x.status),
    logs: batch.flatMap((x) => (x.logs ?? []) as unknown as Log[]),
    fromDelta: delta(0),
    toDelta: delta(1),
    usdcDelta: delta(2),
    usdcAfter: ok ? uint(b[2]) : 0n,
    suppliedDelta: delta(3),
    debtDelta: delta(4),
  };
}

const plenty: Cash = { walletRaw: parseUnits("10", 6), savingsRaw: 0n, saveOn: false };
const none: Cash = { walletRaw: 0n, savingsRaw: 0n, saveOn: false };

describe("trading one stock for another on Base (the Trade sheet)", () => {
  it("newcomer: about $3 of NVDA into Apple, the buy spending exactly the sale's floor, in one batch", async () => {
    const sharesRaw = sharesForUsdRaw(parseUnits("3", 6), await priceRawOf(nvda), nvda.decimals);
    const t = await trade(newcomer, nvda, aapl, sharesRaw, plenty);
    expect(t.buyIn).toBe(t.floor);
    const r = await simulate(newcomer, nvda, aapl, t.calls);
    console.log(
      `NVDA → AAPL: ${sharesRaw} raw NVDA on ${t.sellQuote.venue} for at least $${(Number(t.floor) / 1e6).toFixed(6)}, ` +
        `buy $${(Number(t.buyIn) / 1e6).toFixed(6)} on ${t.buyQuote.venue} → ${r.toDelta} raw AAPL (at least ${minOut(t.buyQuote.amountOut)}), USDC ${r.usdcDelta}`,
    );
    expect(r.statuses).toEqual(["success", "success", "success", "success"]);
    expect(r.fromDelta).toBe(-sharesRaw);
    expect(r.toDelta).toBeGreaterThanOrEqual(minOut(t.buyQuote.amountOut));
    // The trade never spends the user's own cash: what the sale paid over the floor stays.
    expect(r.usdcDelta).toBeGreaterThanOrEqual(0n);
    expect(decodeActivity(r.logs, newcomer).map((i) => [i.kind, i.symbol])).toEqual([
      ["buy", "AAPLc"],
      ["sell", "NVDAc"],
    ]);
  });

  it("newcomer, cash under the fee buffer: the buy is the floor less $0.50, which stays in the wallet for the fee", async () => {
    const sharesRaw = sharesForUsdRaw(parseUnits("3", 6), await priceRawOf(nvda), nvda.decimals);
    const t = await trade(newcomer, nvda, aapl, sharesRaw, none);
    expect(t.buyIn).toBe(t.floor - feeBufferRaw);
    const r = await simulate(newcomer, nvda, aapl, t.calls);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.usdcDelta).toBeGreaterThanOrEqual(feeBufferRaw);
  });

  it("backer: every free Amazon share into NVIDIA, and its backing and what it owes don't move", async () => {
    const freeRaw = await client.readContract({ address: amzn.address, abi: erc20Abi, functionName: "balanceOf", args: [backer] });
    expect((Number(freeRaw) / 10 ** amzn.decimals) * (await priceOf(amzn))).toBeGreaterThan(1.5);
    const cash = await readCash(client, backer);
    const t = await trade(backer, amzn, nvda, freeRaw, cash);
    // The cash pays the fee, from the wallet or savings first, as the sheet signs it.
    const batch = payFromCash(backer, 0n, cash, t.calls);
    const r = await simulate(backer, amzn, nvda, batch);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.fromDelta).toBe(-freeRaw);
    expect(r.toDelta).toBeGreaterThanOrEqual(minOut(t.buyQuote.amountOut));
    expect(r.suppliedDelta).toBe(0n);
    expect(r.debtDelta).toBeLessThan(parseUnits("0.01", 6)); // only interest accruing within the block, if any
    expect(r.debtDelta).toBeGreaterThanOrEqual(0n);
  });

  it("cash in savings with too little in the wallet: a savings withdrawal goes first and the batch goes through", async () => {
    // Put all but $0.20 of the wallet's USDC into savings in the same simulated block, as Save would.
    const wallet = await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [newcomer] });
    const keep = parseUnits("0.2", 6);
    expect(wallet).toBeGreaterThan(parseUnits("1", 6));
    const put = wallet - keep;
    const before: Call[] = [
      { to: USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GUARDIAN.AAVE_V3_POOL, put] }), value: 0n },
      { to: GUARDIAN.AAVE_V3_POOL, data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "supply", args: [USDC.address, put, newcomer, 0] }), value: 0n },
    ];
    const cash: Cash = { walletRaw: keep, savingsRaw: put - 1n, saveOn: false };
    const sharesRaw = sharesForUsdRaw(parseUnits("3", 6), await priceRawOf(nvda), nvda.decimals);
    const t = await trade(newcomer, nvda, aapl, sharesRaw, cash);
    expect(t.buyIn).toBe(t.floor);
    const batch = payFromCash(newcomer, 0n, cash, t.calls);
    expect(batch).toHaveLength(5);
    expect(batch[0].to).toBe(GUARDIAN.AAVE_V3_POOL);
    const r = await simulate(newcomer, nvda, aapl, batch, before);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.usdcAfter).toBeGreaterThanOrEqual(feeBufferRaw);
  });

  it("a buy one unit over the sale's floor can't be built", async () => {
    const sharesRaw = sharesForUsdRaw(parseUnits("3", 6), await priceRawOf(nvda), nvda.decimals);
    const t = await trade(newcomer, nvda, aapl, sharesRaw, plenty);
    const over = await quotePool(client, aapl, t.buyQuote.venue, t.buyQuote.pool, t.floor + 1n, "buy");
    expect(() => buildTradeCalls({ user: newcomer, from: nvda, to: aapl, sellQuote: t.sellQuote, buyQuote: over, oraclePriceUsd: t.oraclePriceUsd })).toThrow(
      /more than the sale is sure to bring/,
    );
  });
});

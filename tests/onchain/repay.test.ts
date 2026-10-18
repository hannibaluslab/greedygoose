/**
 * Simulates the Repay sheet's "Pay with" batches on Base mainnet (eth_simulateV1), from a real account. Nothing is
 * signed or sent. The account is read the way usePosition and useBackingFactors read it, the rows and the amount
 * come from lib/repay.ts as the sheet plans them, quotes from the live pools (read again on their pools the way
 * useSigningQuote reads them before JAW's sheet), and the batch is the one useRepayWith prepares.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  http,
  maxUint256,
  type Abi,
  type Hex,
  type Log,
} from "viem";
import { CHAIN } from "@/lib/chain";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import type { Call } from "@/lib/aave/tx";
import { decodeActivity } from "@/lib/activity/decode";
import { cashRaw, feeBufferRaw, payFromCash, toUsd, type Cash } from "@/lib/cash";
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { REPAY_FORM, planRepay, repaySources, type RepayData, type RepayForm, type RepaySource } from "@/lib/repay";
import { statusFor } from "@/lib/risk/status";
import { assertSaleCoversRepay, buildFreeRepayCalls, buildSaleCalls } from "@/lib/sell";
import { quotePool, quoteSwap, signingQuote } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({
  chain: CHAIN,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  batch: { multicall: true },
});
/** The dev preview's account: backs credit with five stocks, owes about $1,735, and holds about $5.70 of Microsoft free (2026-10-15). */
const backer: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const msft = EQUITIES.find((e) => e.symbol === "MSFTc")!;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

const uiMultiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
type Read = { to: Address; data: Hex; abi: Abi; functionName: string };
const read = (to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Read => ({
  to,
  abi,
  functionName,
  data: encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]),
});
const plain = (calls: { to: Address; data: Hex }[]) => calls.map(({ to, data }) => ({ to, data }));
const decode = (r: Read, x: { data: Hex }) =>
  decodeFunctionResult({ abi: r.abi, functionName: r.functionName, data: x.data } as Parameters<
    typeof decodeFunctionResult
  >[0]);

/** Calls that leave the account with no cash at all, in the same simulated block: the wallet's USDC and all its savings go elsewhere. */
async function noCash(user: Address): Promise<Call[]> {
  const wallet = await client.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [user],
  });
  return [
    {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DEAD, wallet] }),
      value: 0n,
    },
    {
      to: PROTOCOLS.AAVE_V3_POOL,
      data: encodeFunctionData({
        abi: aaveV3PoolAbi,
        functionName: "withdraw",
        args: [USDC.address, maxUint256, DEAD],
      }),
      value: 0n,
    },
  ];
}

/** The account as usePosition and useBackingFactors read it, after `before` when given: what the Repay sheet plans on. */
async function dataOf(user: Address, before: Call[] = []): Promise<{ data: RepayData; cfs: Record<string, number> }> {
  const perStock = EQUITIES.flatMap((e) => [
    read(e.address, erc20Abi, "balanceOf", [user]),
    read(AAVE.SPOKE, spokeAbi, "getUserSuppliedAssets", [BigInt(e.reserveId), user]),
    read(AAVE.SPOKE_ORACLE, aaveOracleAbi, "getReservePrice", [BigInt(e.reserveId)]),
    read(e.address, uiMultiplierAbi, "uiMultiplier"),
    read(AAVE.SPOKE, spokeAbi, "getReserveConfig", [BigInt(e.reserveId)]),
    read(AAVE.SPOKE, spokeAbi, "getReserve", [BigInt(e.reserveId)]),
  ]);
  const tail = [
    read(AAVE.SPOKE, spokeAbi, "getUserAccountData", [user]),
    read(AAVE.SPOKE, spokeAbi, "getUserTotalDebt", [BigInt(USDC.reserveId), user]),
    read(USDC.address, erc20Abi, "balanceOf", [user]),
    read(PROTOCOLS.AUSDC, erc20Abi, "balanceOf", [user]),
  ];
  const reads = [...perStock, ...tail];
  const r = await client.simulateCalls({ account: user, calls: [...plain(before), ...plain(reads)] });
  expect(r.results.every((x) => x.status === "success")).toBe(true);
  const out = r.results.slice(before.length).map((x, i) => decode(reads[i], x));
  const PER = 6;
  const holdings = EQUITIES.map((e, i) => {
    const [bal, supplied, price, , cfg] = out.slice(i * PER, i * PER + PER) as [
      bigint,
      bigint,
      bigint,
      bigint,
      { paused: boolean },
    ];
    const priceUsd = priceToUsd(price);
    const usd = (raw: bigint) => (Number(raw) / 10 ** e.decimals) * priceUsd;
    return {
      symbol: e.symbol,
      name: e.name,
      priceUsd,
      freeRaw: bal,
      backingRaw: supplied,
      freeUsd: usd(bal),
      backingUsd: usd(supplied),
      paused: cfg.paused,
      multiplier: out[i * PER + 3] as bigint,
    };
  });
  const cfs = Object.fromEntries(
    await Promise.all(
      EQUITIES.map(async (e, i) => {
        const reserve = out[i * PER + 5] as { dynamicConfigKey: number };
        const dyn = await client.readContract({
          address: AAVE.SPOKE,
          abi: spokeAbi,
          functionName: "getDynamicReserveConfig",
          args: [BigInt(e.reserveId), reserve.dynamicConfigKey],
        });
        return [e.symbol, dyn.collateralFactor / 10_000] as const;
      }),
    ),
  );
  const [account, debtRaw, walletRaw, savingsRaw] = out.slice(EQUITIES.length * PER) as [
    AccountData,
    bigint,
    bigint,
    bigint,
  ];
  const s = summarize(account);
  const cash: Cash = { walletRaw, savingsRaw, saveOn: false };
  return {
    data: {
      holdings,
      totalBackingUsd: s.totalBackingUsd,
      avgCf: s.avgCf,
      debtUsd: toUsd(debtRaw),
      debtRaw,
      healthFactor: s.healthFactor,
      status: statusFor(s.healthFactor),
      cash,
      cashUsd: toUsd(cashRaw(cash)),
    },
    cfs,
  };
}

const ready = (q: SellQuote | null) => ({ data: q, isFetching: false, isSuccess: true });

/** The sheet's plan for `source` and `form`: the quote for all its shares, then the quote for the shares the amount sells. */
async function sheet(data: RepayData, source: RepaySource, form: RepayForm) {
  const maxQuote = ready(await quoteSwap(client, source.stock!, source.maxSharesRaw, "sell"));
  const sized = planRepay({ data, source, form, maxQuote });
  expect(sized.sharesRaw).toBeGreaterThan(0n);
  const quote = ready(await quoteSwap(client, source.stock!, sized.sharesRaw, "sell"));
  return planRepay({ data, source, form, maxQuote, quote });
}

/** The quote the batch signs with: the screen's, once it's read again on its pool and still pays the screen's floor (useSigningQuote). */
async function stillPays(stock: ReserveAsset, shown: SellQuote) {
  const fresh = await quotePool(client, stock, shown.venue, shown.pool, shown.amountIn, "sell");
  expect(signingQuote(shown, fresh)).not.toBeNull();
}

/** Simulates `before` then the batch, and reads the account around the batch. */
async function simulate(user: Address, stock: ReserveAsset, calls: Call[], before: Call[] = []) {
  const reads = [
    read(stock.address, erc20Abi, "balanceOf", [user]),
    read(AAVE.SPOKE, spokeAbi, "getUserSuppliedAssets", [BigInt(stock.reserveId), user]),
    read(USDC.address, erc20Abi, "balanceOf", [user]),
    read(PROTOCOLS.AUSDC, erc20Abi, "balanceOf", [user]),
    read(AAVE.SPOKE, spokeAbi, "getUserTotalDebt", [BigInt(USDC.reserveId), user]),
    read(AAVE.SPOKE, spokeAbi, "getUserAccountData", [user]),
  ];
  const r = await client.simulateCalls({
    account: user,
    calls: [...plain(before), ...plain(reads), ...plain(calls), ...plain(reads)],
  });
  const batch = r.results.slice(before.length + reads.length, before.length + reads.length + calls.length);
  const ok = batch.every((x) => x.status === "success");
  const a = r.results.slice(before.length, before.length + reads.length).map((x, i) => decode(reads[i], x));
  const b = ok ? r.results.slice(-reads.length).map((x, i) => decode(reads[i], x)) : a;
  const delta = (i: number) => (b[i] as bigint) - (a[i] as bigint);
  return {
    statuses: batch.map((x) => x.status),
    logs: batch.flatMap((x) => (x.logs ?? []) as unknown as Log[]),
    stockDelta: delta(0),
    suppliedDelta: delta(1),
    walletDelta: delta(2),
    savingsDelta: delta(3),
    debtDelta: delta(4),
    walletAfter: b[2] as bigint,
    hfBefore: summarize(a[5] as AccountData).healthFactor,
    hfAfter: summarize(b[5] as AccountData).healthFactor,
  };
}

describe("Repay · Pay with on Base: the rows for the preview account", () => {
  it("cash first, then the stocks held free, then the stocks that back the credit, each able to repay $1", async () => {
    const { data, cfs } = await dataOf(backer);
    const rows = repaySources(data, cfs);
    console.log(rows.map((r) => `${r.id} (up to $${r.estUsd.toFixed(2)})`).join(", "));
    expect(rows[0].id).toBe("cash");
    const kinds = rows.map((r) => r.kind);
    expect(kinds.lastIndexOf("free")).toBeLessThan(kinds.indexOf("backing"));
    expect(rows.some((r) => r.id === "free:MSFTc")).toBe(true);
    expect(rows.filter((r) => r.kind === "backing").length).toBeGreaterThan(0);
    for (const r of rows) expect(r.estUsd).toBeGreaterThanOrEqual(1);
  });
});

describe("Repay · Pay with a stock held free, on Base", () => {
  it("All: every free Microsoft share sells, exactly the sale's floor is repaid, backing doesn't move, the cash pays the fee", async () => {
    const { data, cfs } = await dataOf(backer);
    const source = repaySources(data, cfs).find((r) => r.id === "free:MSFTc")!;
    expect(source.feeFromSale).toBe(false);
    const v = await sheet(data, source, REPAY_FORM);
    expect(v.ready).toBe(true);
    expect(v.sharesRaw).toBe(source.holding!.freeRaw);
    await stillPays(msft, v.quote!);
    const calls = payFromCash(
      backer,
      0n,
      data.cash,
      buildFreeRepayCalls({
        user: backer,
        stock: msft,
        quote: v.quote!,
        oraclePriceUsd: source.holding!.priceUsd,
        debtRaw: data.debtRaw,
        feeFromSale: false,
      }),
    );
    const floor = sellMinOut(v.quote!, msft, source.holding!.priceUsd);
    const r = await simulate(backer, msft, calls);
    console.log(
      `free MSFT, All: ${v.sharesLine}; floor $${toUsd(floor).toFixed(4)}, repaid $${toUsd(v.repayRaw).toFixed(4)}; ` +
        `debt −$${toUsd(-r.debtDelta).toFixed(4)}, wallet +$${toUsd(r.walletDelta).toFixed(4)}; HF ${r.hfBefore?.toFixed(4)} → ${r.hfAfter?.toFixed(4)}`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(v.repayRaw).toBe(floor);
    expect(r.stockDelta).toBe(-source.holding!.freeRaw);
    expect(r.suppliedDelta).toBe(0n);
    expect(-r.debtDelta).toBeGreaterThanOrEqual(v.repayRaw - 10n); // interest accrues by the second
    expect(-r.debtDelta).toBeLessThanOrEqual(v.repayRaw);
    expect(r.walletDelta).toBeGreaterThanOrEqual(0n); // what the sale brought above its floor stays as cash
    expect(r.savingsDelta).toBe(0n);
    expect(r.hfAfter!).toBeGreaterThan(r.hfBefore!);
    expect(
      decodeActivity(r.logs, backer)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(["repay", "sell"]);
  });

  it("$2: sells only the shares whose floor brings $2, and repays that floor", async () => {
    const { data, cfs } = await dataOf(backer);
    const source = repaySources(data, cfs).find((r) => r.id === "free:MSFTc")!;
    const v = await sheet(data, source, { source: source.id, amount: "2", all: false });
    expect(v.ready).toBe(true);
    expect(v.sharesRaw).toBeLessThan(source.holding!.freeRaw);
    // The floor brings $2, give or take a pool tick between the sheet's two quotes (it's live).
    expect(v.repayRaw).toBeGreaterThanOrEqual(1_998_000n);
    expect(v.repayRaw).toBeLessThan(2_050_000n);
    const calls = payFromCash(
      backer,
      0n,
      data.cash,
      buildFreeRepayCalls({
        user: backer,
        stock: msft,
        quote: v.quote!,
        oraclePriceUsd: source.holding!.priceUsd,
        debtRaw: data.debtRaw,
        feeFromSale: false,
      }),
    );
    const r = await simulate(backer, msft, calls);
    console.log(
      `free MSFT, $2: ${v.sharesLine}; repaid $${toUsd(v.repayRaw).toFixed(4)}, debt −$${toUsd(-r.debtDelta).toFixed(4)}`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.stockDelta).toBe(-v.sharesRaw);
    expect(-r.debtDelta).toBeGreaterThanOrEqual(v.repayRaw - 10n);
    expect(r.walletDelta).toBeGreaterThanOrEqual(0n);
  });

  it("with no cash, the sale pays the network fee: it repays the floor less the fee buffer, and at least the buffer stays in the wallet", async () => {
    const before = await noCash(backer);
    const { data, cfs } = await dataOf(backer, before);
    expect(cashRaw(data.cash)).toBe(0n);
    const rows = repaySources(data, cfs);
    expect(rows.some((r) => r.kind === "cash")).toBe(false);
    const source = rows.find((r) => r.id === "free:MSFTc")!;
    expect(source.feeFromSale).toBe(true);
    const v = await sheet(data, source, REPAY_FORM);
    expect(v.ready).toBe(true);
    expect(v.source.feeFromSale).toBe(true);
    const calls = buildFreeRepayCalls({
      user: backer,
      stock: msft,
      quote: v.quote!,
      oraclePriceUsd: source.holding!.priceUsd,
      debtRaw: data.debtRaw,
      feeFromSale: true,
    });
    const floor = sellMinOut(v.quote!, msft, source.holding!.priceUsd);
    expect(v.repayRaw).toBe(floor - feeBufferRaw);
    const r = await simulate(backer, msft, calls, before);
    console.log(
      `free MSFT, no cash: repaid $${toUsd(v.repayRaw).toFixed(4)}; wallet after $${toUsd(r.walletAfter).toFixed(4)}`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.walletAfter).toBeGreaterThanOrEqual(feeBufferRaw);
    expect(-r.debtDelta).toBeGreaterThanOrEqual(v.repayRaw - 10n);
  });

  it("a repay of one unit more than the sale's floor is refused before the wallet sees it", async () => {
    const { data, cfs } = await dataOf(backer);
    const source = repaySources(data, cfs).find((r) => r.id === "free:MSFTc")!;
    const v = await sheet(data, source, REPAY_FORM);
    const calls = buildFreeRepayCalls({
      user: backer,
      stock: msft,
      quote: v.quote!,
      oraclePriceUsd: source.holding!.priceUsd,
      debtRaw: data.debtRaw,
      feeFromSale: false,
    });
    const floor = sellMinOut(v.quote!, msft, source.holding!.priceUsd);
    const more = calls.map((c) =>
      c.to === AAVE.SPOKE
        ? {
            ...c,
            data: encodeFunctionData({
              abi: spokeAbi,
              functionName: "repay",
              args: [BigInt(USDC.reserveId), floor + 1n, backer],
            }),
          }
        : c.to === USDC.address
          ? {
              ...c,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, floor + 1n] }),
            }
          : c,
    );
    expect(() => assertSaleCoversRepay(backer, more, false)).toThrow(/more than the sale is sure to bring/);
  });
});

describe("Repay · Pay with a stock that backs the credit, on Base (the existing repay by selling)", () => {
  it("$5 of NVIDIA: out of backing, sold, the floor less the fee repaid, and the health goes up", async () => {
    const { data, cfs } = await dataOf(backer);
    const source = repaySources(data, cfs).find((r) => r.id === "backing:NVDAc")!;
    const v = await sheet(data, source, { source: source.id, amount: "5", all: false });
    expect(v.ready).toBe(true);
    expect(v.sellPlan?.from).toBe("repay");
    expect(v.source.feeFromSale).toBe(true);
    const calls = buildSaleCalls({
      from: "repay",
      user: backer,
      stock: nvda,
      quote: v.quote!,
      oraclePriceUsd: source.holding!.priceUsd,
      debtRaw: data.debtRaw,
    });
    const r = await simulate(backer, nvda, calls);
    console.log(
      `backing NVDA, $5: ${v.sharesLine}; repaid $${toUsd(v.repayRaw).toFixed(4)}; HF ${r.hfBefore?.toFixed(4)} → ${r.hfAfter?.toFixed(4)} (planned ${v.sellPlan?.hfAfter?.toFixed(4)})`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.suppliedDelta).toBe(-v.sharesRaw);
    expect(r.stockDelta).toBe(0n);
    expect(v.repayRaw).toBeGreaterThanOrEqual(5_000_000n);
    expect(-r.debtDelta).toBeGreaterThanOrEqual(v.repayRaw - 10n);
    expect(r.walletDelta).toBeGreaterThanOrEqual(feeBufferRaw);
    expect(r.hfAfter!).toBeCloseTo(v.sellPlan!.hfAfter!, 2);
  });
});

/**
 * Simulates sell batches on Base mainnet (eth_simulateV1), from real accounts. Nothing is signed or
 * sent. Plans come from live reads (Aave's prices, collateral factors and the position), quotes from
 * the live pools, the same way the app gets them. To try a sale in Watch or near Aave's limit, the
 * simulation first takes credit for the account, in the same simulated block; a small loan is taken
 * the same way, backed by a stock the account supplies first.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, erc20Abi, http, parseUnits, type Log } from "viem";
import { CHAIN } from "@/lib/chain";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { explainRevert } from "@/lib/aave/errors";
import { priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { buildBorrowCalls, buildLoanCalls, type Call } from "@/lib/aave/tx";
import { decodeActivity } from "@/lib/activity/decode";
import { buildSaleCalls, planSell, type SellFrom, type SellHolding, type SellPosition } from "@/lib/sell";
import { quotePool, quoteSwap, signingQuote } from "@/lib/swap/buy";
import type { SellQuote } from "@/lib/swap/sell";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL), batch: { multicall: true } });
/** Backs credit with five stocks (as in flows.test.ts and credit-buy.test.ts), and holds a little free AMZN. */
const backer: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
/** Holds all 7 stocks free and has never backed credit (found via the stocks' Transfer logs, 2026-10-14). */
const newcomer: Address = "0xcd1549f523ad3606cc99950c85711c3dbe62266b";
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const amzn = EQUITIES.find((e) => e.symbol === "AMZNc")!;

const plain = (calls: { to: Address; data: Address }[]) => calls.map(({ to, data }) => ({ to, data }));
const read = (to: Address, data: Address) => ({ to, data });
const balanceRead = (token: Address, user: Address) => read(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }));
const suppliedRead = (stock: ReserveAsset, user: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(stock.reserveId), user] }));
const debtRead = (user: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] }));
const accountRead = (user: Address) => read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [user] }));
const uint = (x: { data: Address }) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });
const account = (x: { data: Address }) =>
  summarize(decodeFunctionResult({ abi: spokeAbi, functionName: "getUserAccountData", data: x.data }) as AccountData);

/** What usePosition and useCollateralFactors read for one stock, as planSell takes it, after `before` when given. */
async function holdingOf(user: Address, stock: ReserveAsset, before: Call[] = []): Promise<SellHolding & { cf: number }> {
  const id = BigInt(stock.reserveId);
  const [held, price, cfg, reserve] = await Promise.all([
    client.simulateCalls({ account: user, calls: [...plain(before), balanceRead(stock.address, user), suppliedRead(stock, user)] }),
    client.readContract({ address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [id] }),
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [id] }),
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserve", args: [id] }),
  ]);
  expect(held.results.every((x) => x.status === "success")).toBe(true);
  const [freeRaw, lockedRaw] = held.results.slice(before.length).map(uint);
  const dyn = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getDynamicReserveConfig", args: [id, reserve.dynamicConfigKey] });
  const priceUsd = priceToUsd(price);
  return { priceUsd, freeRaw, lockedRaw, lockedUsd: (Number(lockedRaw) / 10 ** stock.decimals) * priceUsd, paused: cfg.paused, cf: dyn.collateralFactor / 10_000 };
}

/** The position as usePosition reads it, after `before` (credit taken in the same simulated block) when given. */
async function positionOf(user: Address, before: Call[] = []): Promise<SellPosition> {
  const r = await client.simulateCalls({ account: user, calls: [...plain(before), accountRead(user), debtRead(user)] });
  expect(r.results.every((x) => x.status === "success")).toBe(true);
  const [acc, debt] = r.results.slice(before.length);
  const s = account(acc);
  const debtRaw = uint(debt);
  return { collateralUsd: s.collateralUsd, avgCf: s.avgCf, debtUsd: Number(debtRaw) / 10 ** USDC.decimals, debtRaw, healthFactor: s.healthFactor };
}

/** Credit that takes the account to health factor `hf`. */
async function creditTo(user: Address, hf: number): Promise<Call[]> {
  const p = await positionOf(user);
  const more = (p.collateralUsd * p.avgCf) / hf - p.debtUsd;
  return buildBorrowCalls({ user, amountRaw: parseUnits(more.toFixed(6), 6) });
}

/** Raw shares worth `usd` at Aave's price. */
const sharesFor = (usd: number, h: SellHolding, stock: ReserveAsset) => BigInt(Math.floor((usd / h.priceUsd) * 10 ** stock.decimals));

/** The best live quote, read again on its pool the way useSigningQuote does right before Face ID. */
async function quoteToSign(stock: ReserveAsset, sharesRaw: bigint): Promise<SellQuote> {
  const shown = await quoteSwap(client, stock, sharesRaw, "sell");
  expect(shown).not.toBeNull();
  const signed = signingQuote(shown!, await quotePool(client, stock, shown!.venue, shown!.pool, sharesRaw, "sell"));
  expect(signed).not.toBeNull();
  return signed!;
}

/** Plans the sale on live reads, as a sell screen would. */
async function planned(from: SellFrom, user: Address, stock: ReserveAsset, sharesRaw: bigint, before: Call[] = []) {
  const [holding, position, quote] = await Promise.all([holdingOf(user, stock, before), positionOf(user, before), quoteToSign(stock, sharesRaw)]);
  const plan = planSell({ from, stock, holding, cf: holding.cf, position, quote });
  const calls = () => buildSaleCalls({ from, user, stock, quote, oraclePriceUsd: holding.priceUsd, debtRaw: position.debtRaw });
  return { holding, position, quote, plan, calls };
}

/** Simulates `before` then the sale, and reads the account around the sale. */
async function simulateSale(user: Address, stock: ReserveAsset, calls: Call[], before: Call[] = []) {
  const reads = [balanceRead(stock.address, user), suppliedRead(stock, user), balanceRead(USDC.address, user), debtRead(user), accountRead(user)];
  const r = await client.simulateCalls({ account: user, calls: [...plain(before), ...reads, ...plain(calls), ...reads] });
  const sale = r.results.slice(before.length + reads.length, before.length + reads.length + calls.length);
  const [a, b] = [r.results.slice(before.length, before.length + reads.length), r.results.slice(-reads.length)];
  const delta = (i: number) => (sale.every((x) => x.status === "success") ? uint(b[i]) - uint(a[i]) : 0n);
  return {
    statuses: sale.map((x) => x.status),
    sale,
    logs: sale.flatMap((x) => (x.logs ?? []) as unknown as Log[]),
    stockDelta: delta(0),
    suppliedDelta: delta(1),
    usdcDelta: delta(2),
    debtDelta: delta(3),
    debtAfter: uint(b[3]),
    hfBefore: account(a[4]).healthFactor,
    hfAfter: sale.every((x) => x.status === "success") ? account(b[4]).healthFactor : null,
  };
}

describe("selling free shares on Base (plan item 7 step 2)", () => {
  it("approve → swap: about $1 of free NVDA sells for at least the floor, to the user", async () => {
    const { plan, calls } = await planned("free", newcomer, nvda, sharesFor(1.1, await holdingOf(newcomer, nvda), nvda));
    expect(plan.block).toBeUndefined();
    const r = await simulateSale(newcomer, nvda, calls());
    console.log(`free: ${plan.sharesRaw} raw NVDA → $${plan.usd.toFixed(4)} (at least $${(Number(plan.minOutRaw) / 1e6).toFixed(4)})`);
    expect(r.statuses).toEqual(["success", "success"]);
    expect(r.stockDelta).toBe(-plan.sharesRaw);
    expect(r.usdcDelta).toBeGreaterThanOrEqual(plan.minOutRaw);
    expect(decodeActivity(r.logs, newcomer)).toEqual([
      { kind: "sell", symbol: "NVDAc", amount: Number(plan.sharesRaw) / 1e8, receivedUsd: Number(r.usdcDelta) / 1e6 },
    ]);
  });

  it("an account that backs credit sells its free shares, and its backing and loan don't move", async () => {
    const holding = await holdingOf(backer, amzn);
    expect((Number(holding.freeRaw) / 10 ** amzn.decimals) * holding.priceUsd).toBeGreaterThan(1);
    const { plan, calls } = await planned("free", backer, amzn, holding.freeRaw);
    expect(plan.block).toBeUndefined();
    const r = await simulateSale(backer, amzn, calls());
    expect(r.statuses).toEqual(["success", "success"]);
    expect(r.stockDelta).toBe(-holding.freeRaw);
    expect(r.suppliedDelta).toBe(0n);
    expect(r.usdcDelta).toBeGreaterThanOrEqual(plan.minOutRaw);
  });

  it("selling more than is free is blocked before the wallet sees it", async () => {
    const holding = await holdingOf(backer, nvda);
    const { plan } = await planned("free", backer, nvda, holding.freeRaw + sharesFor(5, holding, nvda));
    expect(plan.block).toBe("not-free");
  });
});

describe("selling a backing holding on Base (plan item 7 step 3)", () => {
  it("take out → approve → swap: $5 of NVDA leaves backing and sells, the wallet's NVDA unchanged", async () => {
    const { plan, calls } = await planned("backing", backer, nvda, sharesFor(5, await holdingOf(backer, nvda), nvda));
    expect(plan.block).toBeUndefined();
    const r = await simulateSale(backer, nvda, calls());
    expect(r.statuses).toEqual(["success", "success", "success"]);
    expect(r.suppliedDelta).toBe(-plan.sharesRaw);
    expect(r.stockDelta).toBe(0n);
    expect(r.usdcDelta).toBeGreaterThanOrEqual(plan.minOutRaw);
    expect(decodeActivity(r.logs, backer).map((i) => i.kind)).toEqual(["withdraw", "sell"]);
  });

  it("only as far as the loan stays Safe: past it is blocked with why, up to it goes through and ends Safe", async () => {
    const before = await creditTo(backer, 1.6);
    const holding = await holdingOf(backer, nvda);
    const position = await positionOf(backer, before);
    expect(position.healthFactor!).toBeCloseTo(1.6, 2);
    const past = await planned("backing", backer, nvda, holding.lockedRaw, before);
    expect(past.plan.block).toBe("past-safe");
    expect(past.plan.maxRaw).toBeGreaterThan(0n);

    const within = await planned("backing", backer, nvda, (past.plan.maxRaw * 9n) / 10n, before);
    expect(within.plan.block).toBeUndefined();
    const r = await simulateSale(backer, nvda, within.calls(), before);
    console.log(`backing at HF 1.6: up to ${past.plan.maxRaw} raw NVDA; sold 90% of it → HF ${r.hfAfter?.toFixed(3)} (planned ${within.plan.hfAfter?.toFixed(3)})`);
    expect(r.statuses).toEqual(["success", "success", "success"]);
    expect(r.hfAfter!).toBeGreaterThanOrEqual(1.5);
    expect(r.hfAfter!).toBeCloseTo(within.plan.hfAfter!, 2);
  });
});

describe("repaying by selling a holding on Base (plan item 7 step 9)", () => {
  for (const [status, hf] of [["Safe", 2], ["Watch", 1.3]] as const) {
    it(`in ${status}: take out → approve → swap → approve → repay, and the loan ends healthier`, async () => {
      const before = await creditTo(backer, hf);
      const { plan, calls } = await planned("repay", backer, nvda, sharesFor(50, await holdingOf(backer, nvda), nvda), before);
      expect(plan.before).toBe(status.toLowerCase());
      expect(plan.block).toBeUndefined();
      const r = await simulateSale(backer, nvda, calls(), before);
      console.log(`repay in ${status}: repays $${(Number(plan.repayRaw) / 1e6).toFixed(2)}; HF ${r.hfBefore?.toFixed(3)} → ${r.hfAfter?.toFixed(3)}`);
      expect(r.statuses).toEqual(["success", "success", "success", "success", "success"]);
      expect(r.suppliedDelta).toBe(-plan.sharesRaw);
      expect(-r.debtDelta).toBeGreaterThanOrEqual(plan.repayRaw - 10n); // interest accrues by the second
      expect(r.usdcDelta).toBeGreaterThanOrEqual(parseUnits("0.5", 6)); // the network fee buffer stays in the wallet
      expect(r.hfAfter!).toBeGreaterThan(r.hfBefore!);
      expect(r.hfAfter!).toBeCloseTo(plan.hfAfter!, 2);
      expect(decodeActivity(r.logs, backer).map((i) => i.kind)).toEqual(["withdraw", "repay", "sell"]);
    });
  }

  it("a small loan: one sale repays all of it", async () => {
    // A $5 loan backed by $20 of NVDA, taken first in the same simulated block: the backer's own loan is live and moves.
    const free = await holdingOf(newcomer, nvda);
    const before = buildLoanCalls({ user: newcomer, locks: [{ stock: nvda, raw: sharesFor(20, free, nvda) }], borrowRaw: parseUnits("5", 6) });
    const position = await positionOf(newcomer, before);
    expect(position.debtRaw).toBeGreaterThan(0n);
    const { plan, calls } = await planned("repay", newcomer, nvda, sharesFor(position.debtUsd + 2, free, nvda), before);
    expect(plan.block).toBeUndefined();
    expect(plan.after).toBe("none");
    const built = calls();
    expect(built).toHaveLength(6); // … repay, then the leftover allowance back to 0
    const r = await simulateSale(newcomer, nvda, built, before);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.debtAfter).toBe(0n);
  });

  it("near Aave's limit: blocked with why, and Aave refuses the batch the same way", async () => {
    const before = await creditTo(backer, 1.02);
    const { plan, calls } = await planned("repay", backer, nvda, sharesFor(400, await holdingOf(backer, nvda), nvda), before);
    expect(plan.before).toBe("act");
    expect(plan.block).toBe("near-limit");
    const built = calls();
    const r = await simulateSale(backer, nvda, built, before);
    expect(r.statuses[0]).toBe("failure");
    const msg = explainRevert(r.sale[0].data, "fallback", built[0]);
    console.log("near the limit →", msg);
    expect(msg).toMatch(/past what Aave allows/);
  });
});

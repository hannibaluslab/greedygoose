/**
 * Simulates Credit Buy's Cash row on Base mainnet (eth_simulateV1), from real accounts, through the plan the screen signs
 * (toCashPlan): the backing step 1 picks (Credit ready, or one stock with just enough put in use), the credit, then
 * exactly that credit supplied into savings for the account, in one batch. Nothing is signed or sent. Plans come from
 * live reads (Aave's prices, collateral factors, liquidity and both rates), the way the app gets them. Run it on a
 * keyless public RPC: NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org.
 *
 * A simulation from the account itself carries no paymaster, so no network fee is taken: the wallet's USDC must not
 * move at all. All of the credit earns, so the wallet keeps only what it had: the fuel tank.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  parseUnits,
  type Log,
} from "viem";
import { decodeActivity } from "@/lib/activity/decode";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { hubAbi } from "@/lib/aave/abis/IHub";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { aprToApy, creditApr, priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { buildSupplyCalls, type Call } from "@/lib/aave/tx";
import type { Cash } from "@/lib/cash";
import { CHAIN } from "@/lib/chain";
import {
  CREDIT_FLOOR,
  backingForBuy,
  backingOptions,
  creditWith,
  ownCreditUsd,
  planCredit,
  type BackingOption,
  type CreditPosition,
} from "@/lib/creditBuy";
import { toCashQuote, toCashStop } from "@/lib/creditBuy/toCash";
import { PROTOCOLS } from "@/lib/protocols/config";
import { toCashPlan } from "@/lib/tx/plans";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({
  chain: CHAIN,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  batch: { multicall: true },
});
/** Holds all 7 stocks and USDC but backs no credit (earn.test.ts). */
const newcomer: Address = "0xb5ef91ce939f2c390cff462bb231e74bb228deb4";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const v3ReserveAbi = parseAbi([
  "function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))",
]);

/** What usePosition and useBackingFactors read: the position, the free stock that can back credit, the cash, both rates. */
async function live(user: Address) {
  const [account, liquidity, usdcCfg, walletRaw, savingsRaw, drawn, premium, v3] = await Promise.all([
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
    client.readContract({
      address: AAVE.HUB,
      abi: hubAbi,
      functionName: "getAssetDrawnRate",
      args: [BigInt(USDC.reserveId)],
    }),
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserLastRiskPremium", args: [user] }),
    client.readContract({
      address: PROTOCOLS.AAVE_V3_POOL,
      abi: v3ReserveAbi,
      functionName: "getReserveData",
      args: [USDC.address],
    }),
  ]);
  const summary = summarize(account as AccountData);
  const position: CreditPosition = {
    ...summary,
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
  const cash: Cash = { walletRaw, savingsRaw, saveOn: false };
  return {
    position,
    options: backingOptions(holdings, cfs),
    cash,
    creditApy: aprToApy(creditApr(drawn, premium)),
    cashApy: aprToApy(Number(v3[2]) / 1e27),
  };
}

type Live = Awaited<ReturnType<typeof live>>;

/**
 * The batch the Cash row signs for `amountUsd` on step 1's pick (none: Credit ready), as toCashPlan builds it, from
 * the live reads `l` (or the position after a setup batch).
 */
async function signedBatch(user: Address, l: Live, amountUsd: number, option: BackingOption | null) {
  const pick = { option, raw: option ? backingForBuy(option, amountUsd) : 0n };
  const plan = planCredit({ position: l.position, backing: pick, creditRaw: usd(amountUsd), cash: l.cash });
  // The rate after it, as the screen reads it, is a simulation of this same batch; today's rate stands in here.
  const quote = toCashQuote({
    plan,
    debtUsd: l.position.debtUsd,
    cashApy: l.cashApy,
    creditApyNow: l.creditApy,
    creditApyAfter: l.creditApy,
  });
  const confirmedRisk = plan.extraConfirm;
  expect(toCashStop(quote, confirmedRisk)).toBeNull();
  const signing = toCashPlan({ user, quote, confirmedRisk }, async () => l.cash).calls;
  const calls = typeof signing === "function" ? await signing() : signing;
  return { plan, quote, calls };
}

const read = (to: Address, data: Address) => ({ to, data });
const balanceRead = (token: Address, user: Address) =>
  read(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }));
const uint = (x: { data: Address }) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });

/**
 * The batch between two sets of reads in the same block: savings, the wallet, the debt, the stocks, and the health
 * after. `setup` runs first, before the reads (stock put in use, so there's credit ready).
 */
async function simulate(user: Address, calls: Call[], setup: Call[] = []) {
  const reads = [
    balanceRead(PROTOCOLS.AUSDC, user),
    balanceRead(USDC.address, user),
    read(
      AAVE.SPOKE,
      encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] }),
    ),
    ...EQUITIES.map((e) => balanceRead(e.address, user)),
  ];
  const health = read(
    AAVE.SPOKE,
    encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [user] }),
  );
  const r = await client.simulateCalls({
    account: user,
    calls: [...setup, ...reads, ...calls, ...reads, health].map(({ to, data }) => ({ to, data })),
  });
  expect(r.results.slice(0, setup.length).every((x) => x.status === "success")).toBe(true);
  const results = r.results.slice(setup.length);
  const before = results.slice(0, reads.length);
  const batch = results.slice(reads.length, reads.length + calls.length);
  const after = results.slice(reads.length + calls.length, -1);
  const delta = (i: number) => uint(after[i]) - uint(before[i]);
  const account = summarize(
    decodeFunctionResult({
      abi: spokeAbi,
      functionName: "getUserAccountData",
      data: r.results.at(-1)!.data,
    }) as AccountData,
  );
  return {
    statuses: batch.map((x) => x.status),
    logs: batch.flatMap((x) => x.logs ?? []) as unknown as Log[],
    savingsAdded: delta(0),
    walletDelta: delta(1),
    debtAdded: delta(2),
    stockOut: Object.fromEntries(EQUITIES.map((e, i) => [e.symbol, -delta(3 + i)])),
    hfAfter: account.healthFactor,
  };
}

/** Step 1's pick for the newcomer: its biggest free holding. */
const most = (options: BackingOption[]) => options.reduce((a, b) => (b.freeUsd > a.freeUsd ? b : a));

/** aUSDC rounds by a unit or two per savings call (Aave V3's ray maths): 3 units, $0.000003. */
const closeTo = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 3n;

describe("Credit Buy's Cash row simulates on mainnet: the credit lands in savings, the wallet doesn't move", () => {
  it("Credit ready: credit from what already backs credit, straight into savings", async () => {
    // No live account backs credit with some left today (the preview account repaid it all), so the newcomer puts half
    // its biggest holding in use first, in the same simulation, and the Cash row's batch runs on that position.
    const l = await live(newcomer);
    const option = most(l.options);
    const half = option.freeRaw / 2n;
    const setup = buildSupplyCalls({ user: newcomer, stock: option.stock, amountRaw: half });
    const position: CreditPosition = {
      ...l.position,
      totalBackingUsd: (option.freeUsd * Number(half)) / Number(option.freeRaw),
      avgCf: option.cf,
    };
    const amount = Math.min(5, creditWith(position));
    expect(amount).toBeGreaterThan(0);
    const { plan, quote, calls } = await signedBatch(newcomer, { ...l, position }, amount, null);
    expect(plan.backing).toEqual([]);
    expect(calls.map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, PROTOCOLS.AAVE_V3_POOL]);
    const r = await simulate(newcomer, calls, setup);
    console.log(
      `Credit ready $${amount} on ${option.stock.symbol}: earns ${quote.earn / 10}%, costs ${quote.cost! / 10}%; savings +${r.savingsAdded}, wallet ${r.walletDelta}, debt +${r.debtAdded}, health after ${r.hfAfter?.toFixed(3)}`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(closeTo(r.savingsAdded, usd(amount))).toBe(true);
    expect(r.walletDelta).toBe(0n);
    expect(r.debtAdded).toBeGreaterThanOrEqual(usd(amount));
    expect(r.debtAdded).toBeLessThan(usd(amount) + 10n);
    expect(r.hfAfter).toBeGreaterThanOrEqual(CREDIT_FLOOR.minHf);
    expect(decodeActivity(r.logs, newcomer)).toEqual([{ kind: "earn", symbol: "USDC", amount }]);
  });

  it("an account that never backed credit: step 1's stock goes in use, just enough, then the credit into savings", async () => {
    const l = await live(newcomer);
    expect(l.position.totalBackingUsd).toBe(0);
    const option = most(l.options);
    const amount = Math.min(5, ownCreditUsd(l.position, option));
    const { plan, calls } = await signedBatch(newcomer, l, amount, option);
    expect(plan.backing).toHaveLength(1);
    expect(plan.backing[0].raw).toBeLessThanOrEqual(option.freeRaw);
    expect(calls).toHaveLength(6);
    const r = await simulate(newcomer, calls);
    console.log(
      `newcomer, $${amount} on ${option.stock.symbol}: backing ${plan.backing[0].raw} of ${option.freeRaw}; savings +${r.savingsAdded}, wallet ${r.walletDelta}, health after ${r.hfAfter?.toFixed(3)}`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(closeTo(r.savingsAdded, usd(amount))).toBe(true);
    expect(r.walletDelta).toBe(0n);
    expect(r.stockOut[option.stock.symbol]).toBe(plan.backing[0].raw);
    expect(r.hfAfter).toBeGreaterThanOrEqual(CREDIT_FLOOR.minHf);
    expect(decodeActivity(r.logs, newcomer).map((i) => i.kind)).toEqual(["earn", "supply"]);
  });
});

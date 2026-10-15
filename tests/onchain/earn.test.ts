/**
 * Simulates Earn with stocks' batch on Base mainnet (eth_simulateV1), from real accounts: stock put in use, the credit
 * taken, then exactly that credit supplied into savings for the account, in one batch. Nothing is signed or sent. Plans
 * come from live reads (Aave's prices, collateral factors and liquidity), the way the app gets them.
 *
 * A simulation from the account itself carries no paymaster, so no network fee is taken here: the wallet's USDC must
 * not move at all, except for the fee buffer a savings withdrawal leaves behind when the wallet can't pay the fee.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, parseUnits, zeroHash,
  type Log, type StateOverride,
} from "viem";
import { decodeActivity } from "@/lib/activity/decode";
import { CASH } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { hubAbi } from "@/lib/aave/abis/IHub";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import type { Cash } from "@/lib/cash";
import { CHAIN } from "@/lib/chain";
import { backingOptions, planCredit, type CreditPosition } from "@/lib/creditBuy";
import { buildEarnCalls, earnOffer } from "@/lib/earnWithStocks";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL), batch: { multicall: true } });
/** The dev preview's account: already backs credit (Amazon and more), with savings and wallet USDC. */
const preview: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
/** Holds all 7 stocks and USDC but has never backed credit (found via the stocks' Transfer logs, 2026-10-14). */
const newcomer: Address = "0xcd1549f523ad3606cc99950c85711c3dbe62266b";
const feeBuffer = parseUnits(CASH.feeBufferUsd.toFixed(6), 6);
const usd = (n: number) => parseUnits(n.toFixed(6), 6);

/** What usePosition and useCollateralFactors read, for earnOffer and planCredit. No executor: Save is off (the public link). */
async function live(user: Address) {
  const [account, liquidity, usdcCfg, walletRaw, savingsRaw] = await Promise.all([
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [user] }),
    client.readContract({ address: AAVE.HUB, abi: hubAbi, functionName: "getAssetLiquidity", args: [BigInt(USDC.reserveId)] }),
    client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [BigInt(USDC.reserveId)] }),
    client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    client.readContract({ address: GUARDIAN.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
  ]);
  const position: CreditPosition = {
    ...summarize(account as AccountData),
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
  const cash: Cash = { walletRaw, savingsRaw, saveOn: false };
  return { position, options: backingOptions(holdings, cfs), cash };
}

const read = (to: Address, data: Address) => ({ to, data });
const balanceRead = (token: Address, user: Address) => read(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }));
const debtRead = (user: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] }));
const uint = (x: { data: Address }) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });

/** FiatTokenV2_2 keeps balances in the mapping at slot 9 (checked in flows.test.ts): this empties the wallet. */
const emptyWallet = (user: Address): StateOverride => [
  { address: USDC.address, stateDiff: [{ slot: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, 9n])), value: zeroHash }] },
];

/**
 * Simulates the batch between two sets of reads in the same block (so interest accruing between blocks can't blur the
 * deltas): savings (aUSDC), the wallet's USDC, the debt, and each stock's free shares, before and after.
 */
async function simulateEarn(user: Address, calls: { to: Address; data: Address }[], stateOverrides?: StateOverride) {
  const reads = [balanceRead(GUARDIAN.AUSDC, user), balanceRead(USDC.address, user), debtRead(user), ...EQUITIES.map((e) => balanceRead(e.address, user))];
  const r = await client.simulateCalls({ account: user, calls: [...reads, ...calls, ...reads].map(({ to, data }) => ({ to, data })), stateOverrides });
  const before = r.results.slice(0, reads.length);
  const batch = r.results.slice(reads.length, reads.length + calls.length);
  const after = r.results.slice(reads.length + calls.length);
  const delta = (i: number) => uint(after[i]) - uint(before[i]);
  return {
    statuses: batch.map((x) => x.status),
    /** The batch's logs, as its receipt would carry them (without the paymaster's). */
    logs: batch.flatMap((x) => x.logs ?? []) as unknown as Log[],
    savingsAdded: delta(0),
    walletDelta: delta(1),
    walletAfter: uint(after[1]),
    debtAdded: delta(2),
    stockOut: Object.fromEntries(EQUITIES.map((e, i) => [e.symbol, -delta(3 + i)])),
  };
}

/** aUSDC rounds by a unit or two per savings call (Aave V3's ray maths on the scaled balance): 3 units, $0.000003. */
const closeTo = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 3n;

describe("Earn with stocks simulates on mainnet: the credit lands in savings, the wallet doesn't move", () => {
  it("the preview account: credit from what already backs credit, straight into savings", async () => {
    const { position, options, cash } = await live(preview);
    const offer = earnOffer({ cashApy: 0.04, creditApy: 0.02, position, options, cash });
    expect(offer.kind).toBe("offer");
    const creditRaw = usd(25);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    const calls = buildEarnCalls({ user: preview, backing: plan.backing, creditRaw, cash });
    // Enough USDC in the wallet for the fee: no savings withdrawal, so the batch ends borrow → approve → supply.
    expect(calls.slice(-3).map((c) => c.to)).toEqual([AAVE.SPOKE, USDC.address, GUARDIAN.AAVE_V3_POOL]);
    const r = await simulateEarn(preview, calls);
    console.log(
      `preview: wallet $${Number(cash.walletRaw) / 1e6}, savings $${Number(cash.savingsRaw) / 1e6}; backing ${plan.backing.map((b) => b.stock.symbol).join(", ") || "none new"}; ` +
        `savings +${r.savingsAdded}, wallet ${r.walletDelta}, debt +${r.debtAdded}`,
    );
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(closeTo(r.savingsAdded, creditRaw)).toBe(true);
    expect(r.walletDelta).toBe(0n);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.debtAdded).toBeLessThan(creditRaw + 10n);
    for (const b of plan.backing) expect(r.stockOut[b.stock.symbol]).toBe(b.raw);
    // Activity reads the batch's own logs as one move: the credit that came to the cash, earning; nothing sent.
    expect(decodeActivity(r.logs, preview)).toEqual([{ kind: "earn", symbol: "USDC", amount: 25 }]);
  });

  it("an account that never backed credit: its stock goes in use, then the credit into savings", async () => {
    const { position, options, cash } = await live(newcomer);
    expect(position.collateralUsd).toBe(0);
    expect(options.length).toBeGreaterThan(0);
    const creditRaw = usd(5);
    const plan = planCredit({ position, options, creditRaw, cash });
    expect(plan.block).toBeUndefined();
    expect(plan.backing.length).toBeGreaterThan(0);
    const calls = buildEarnCalls({ user: newcomer, backing: plan.backing, creditRaw, cash });
    expect(calls).toHaveLength(plan.backing.length * 3 + 3);
    const r = await simulateEarn(newcomer, calls);
    console.log(`newcomer: backing ${plan.backing.map((b) => `${b.stock.symbol} ${b.raw}`).join(", ")}; savings +${r.savingsAdded}, wallet ${r.walletDelta}, debt +${r.debtAdded}`);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(closeTo(r.savingsAdded, creditRaw)).toBe(true);
    expect(r.walletDelta).toBe(0n);
    expect(r.debtAdded).toBeGreaterThanOrEqual(creditRaw);
    expect(r.debtAdded).toBeLessThan(creditRaw + 10n);
    for (const b of plan.backing) expect(r.stockOut[b.stock.symbol]).toBe(b.raw);
    expect(decodeActivity(r.logs, newcomer).map((i) => i.kind)).toEqual(["earn", ...plan.backing.map(() => "supply")]);
  });

  it("with an empty wallet, the fee buffer comes out of savings first and the credit still goes in whole", async () => {
    const { position, options, cash: shown } = await live(preview);
    expect(shown.savingsRaw).toBeGreaterThan(feeBuffer);
    const cash: Cash = { ...shown, walletRaw: 0n };
    const creditRaw = usd(25);
    const plan = planCredit({ position, options, creditRaw, cash });
    const calls = buildEarnCalls({ user: preview, backing: plan.backing, creditRaw, cash });
    expect(calls[0].to).toBe(GUARDIAN.AAVE_V3_POOL);
    const r = await simulateEarn(preview, calls, emptyWallet(preview));
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    console.log(`empty wallet: savings +${r.savingsAdded}, wallet after ${r.walletAfter}`);
    // Savings: + the credit − the fee buffer; the wallet keeps exactly the buffer for JAW's fee.
    expect(closeTo(r.savingsAdded, creditRaw - feeBuffer)).toBe(true);
    expect(r.walletAfter).toBe(feeBuffer);
    expect(decodeActivity(r.logs, preview)).toEqual([{ kind: "earn", symbol: "USDC", amount: 25 }]);
  });

  it("the pool takes a supply for anyone: the allowlist's onBehalfOf == user pin is what keeps the money with the user", async () => {
    // Why saveForUser pins onBehalfOf (lib/allowlist.ts): Aave V3's pool on Base accepts supply(USDC, amount, X, 0) for
    // any X, so a batch could otherwise pay the user's USDC into someone else's savings.
    const supply = encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "supply", args: [USDC.address, 1_000n, newcomer, 0] });
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GUARDIAN.AAVE_V3_POOL, 1_000n] });
    const r = await client.simulateCalls({ account: preview, calls: [{ to: USDC.address, data: approve }, { to: GUARDIAN.AAVE_V3_POOL, data: supply }] });
    expect(r.results.map((x) => x.status)).toEqual(["success", "success"]);
  });
});

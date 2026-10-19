/**
 * The Entry coins and venues on Base mainnet (plan item 2 step 1), read live, and the user-signed batch that turns
 * Turn into cash's coins (CASH_COINS, D20) into cash, simulated with eth_simulateV1. Nothing is signed or sent: the
 * quoters run through eth_call, the way the app quotes a buy.
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
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Address,
  type StateOverride,
} from "viem";
import { CHAIN } from "@/lib/chain";
import { ENTRY } from "@/config/risk";
import { decodeActivity } from "@/lib/activity/decode";
import { SEL } from "@/lib/protocols/config";
import {
  buildConvertCalls,
  convertFloorRaw,
  quoteConvert,
  rateUsable,
  readUsdRate,
  type Conversion,
} from "@/lib/swap/entry";
import { AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { USDC } from "@/lib/tokens/registry";
import { CASH_COINS, ENTRY_COINS, type EntryCoinAsset } from "@/lib/tokens/stables";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });
const factoryAbi = parseAbi(["function factory() view returns (address)"]);
const psm3Abi = parseAbi(["function usdc() view returns (address)", "function usds() view returns (address)"]);
const feedAbi = parseAbi(["function description() view returns (string)", "function decimals() view returns (uint8)"]);
const bridgedAbi = parseAbi([
  "function l1Token() view returns (address)",
  "function REMOTE_TOKEN() view returns (address)",
]);
const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** USDC units for `usd` dollars of `coin`, at the venue the Entry job and the user's own conversion swap it on. */
const quote = (coin: EntryCoinAsset, usd: bigint) => quoteConvert(client, coin, usd * 10n ** BigInt(coin.decimals));

const floor = (usd: bigint) => (usd * 10n ** 6n * BigInt(10_000 - ENTRY.floorBps)) / 10_000n;

describe("Entry coins and venues on Base", () => {
  it.each(ENTRY_COINS.map((c) => [c.symbol, c] as const))("%s: symbol and decimals", async (_, c) => {
    expect(await client.readContract({ address: c.address, abi: erc20Abi, functionName: "symbol" })).toBe(c.symbol);
    expect(await client.readContract({ address: c.address, abi: erc20Abi, functionName: "decimals" })).toBe(c.decimals);
  });

  it("USDT and USDbC are the Base bridge's own, USDS is the one PSM3 swaps", async () => {
    const usdt = ENTRY_COINS.find((c) => c.symbol === "USDT")!;
    const usdbc = ENTRY_COINS.find((c) => c.symbol === "USDbC")!;
    const usds = ENTRY_COINS.find((c) => c.symbol === "USDS")!;
    expect(await client.readContract({ address: usdt.address, abi: bridgedAbi, functionName: "l1Token" })).toBe(
      ETHEREUM_USDT,
    );
    expect(await client.readContract({ address: usdbc.address, abi: bridgedAbi, functionName: "REMOTE_TOKEN" })).toBe(
      ETHEREUM_USDC,
    );
    expect(await client.readContract({ address: SPARK_PSM3.PSM3, abi: psm3Abi, functionName: "usds" })).toBe(
      usds.address,
    );
    expect(await client.readContract({ address: SPARK_PSM3.PSM3, abi: psm3Abi, functionName: "usdc" })).toBe(
      USDC.address,
    );
  });

  it("Aerodrome's first Slipstream router and quoter are its factory's, with the tick-spacing swap", async () => {
    for (const address of [AERODROME_V1.ROUTER, AERODROME_V1.QUOTER]) {
      expect(await client.readContract({ address, abi: factoryAbi, functionName: "factory" })).toBe(
        AERODROME_V1.FACTORY,
      );
    }
    expect(
      toFunctionSelector("exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"),
    ).toBe(SEL.aeroSwap);
    expect(await client.getCode({ address: AERODROME_V1.ROUTER })).toContain(SEL.aeroSwap.slice(2));
    expect(await client.getCode({ address: UNISWAP.SWAP_ROUTER_02 })).toContain(SEL.uniSwap.slice(2));
    expect(await client.getCode({ address: SPARK_PSM3.PSM3 })).toContain(SEL.psmSwap.slice(2));
  });

  it.each(ENTRY_COINS.map((c) => [c.symbol, c] as const))(
    "%s: $1,000 and a full swap's worth quote at 99.5% of face value or better",
    async (_, c) => {
      expect(await quote(c, 1_000n)).toBeGreaterThanOrEqual(floor(1_000n));
      const cap = BigInt(ENTRY.maxSwapUsd);
      expect(await quote(c, cap)).toBeGreaterThanOrEqual(floor(cap));
    },
  );
});

describe("Turn into cash's own coins on Base: DAI and EURC", () => {
  const extra = CASH_COINS.filter((c) => !ENTRY_COINS.includes(c));

  it.each(extra.map((c) => [c.symbol, c] as const))("%s: symbol and decimals", async (_, c) => {
    expect(await client.readContract({ address: c.address, abi: erc20Abi, functionName: "symbol" })).toBe(c.symbol);
    expect(await client.readContract({ address: c.address, abi: erc20Abi, functionName: "decimals" })).toBe(c.decimals);
  });

  it("EURC's rate is Chainlink's EUR / USD, fresh, near a euro's price", async () => {
    const eurc = CASH_COINS.find((c) => c.symbol === "EURC")!;
    const feed = eurc.peg!.feed;
    expect(await client.readContract({ address: feed, abi: feedAbi, functionName: "description" })).toBe("EUR / USD");
    expect(await client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" })).toBe(
      eurc.peg!.decimals,
    );
    const rate = await readUsdRate(client, eurc);
    expect(rateUsable(eurc, rate)).toBe(true);
    expect(Number(rate!.answer) / 1e8).toBeGreaterThan(0.9);
    expect(Number(rate!.answer) / 1e8).toBeLessThan(1.4);
  });

  it.each(extra.map((c) => [c.symbol, c] as const))(
    "%s: $1,000 and $10,000 worth quote at its floor or better",
    async (_, c) => {
      const rate = await readUsdRate(client, c);
      for (const n of [1_000n, 10_000n]) {
        const amountIn = n * 10n ** BigInt(c.decimals);
        expect(await quoteConvert(client, c, amountIn)).toBeGreaterThanOrEqual(convertFloorRaw(c, amountIn, rate));
      }
    },
  );
});

/**
 * Where each coin keeps its balances (`mapping(address => uint256)` at this slot), found by setting the slot in a state
 * override and reading balanceOf back; the first test checks it.
 */
const BALANCE_SLOT: Record<string, bigint> = { USDT: 0n, USDe: 5n, USDbC: 51n, USDS: 2n, DAI: 0n, EURC: 9n };
/** A fresh account: no code, no history, holding only what the override gives it. */
const holder: Address = "0x00000000000000000000000000000000c0ffee01";
const balanceSlot = (coin: EntryCoinAsset, who: Address) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, BALANCE_SLOT[coin.symbol]]));
const holding = (coins: readonly { coin: EntryCoinAsset; raw: bigint }[]): StateOverride =>
  coins.map(({ coin, raw }) => ({
    address: coin.address,
    stateDiff: [{ slot: balanceSlot(coin, holder), value: pad(toHex(raw), { size: 32 }) }],
  }));
const balanceRead = (token: Address) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
});
const uint = (data: `0x${string}`) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data });

/**
 * A conversion of all of `usd` of `coin` (euros for EURC, at its live rate), at the floor or the quote less 0.1%,
 * whichever is higher.
 */
async function conversion(coin: EntryCoinAsset, usd: bigint): Promise<Conversion> {
  const amountIn = usd * 10n ** BigInt(coin.decimals);
  const rate = await readUsdRate(client, coin);
  const floor = convertFloorRaw(coin, amountIn, rate);
  const out = await quoteConvert(client, coin, amountIn);
  expect(out).toBeGreaterThanOrEqual(floor);
  const fromQuote = (out * 999n) / 1000n;
  return { coin, amountIn, minOut: fromQuote > floor ? fromQuote : floor, rate };
}

describe("the user's own conversion into cash (D20), simulated on Base", () => {
  it("finds each coin's balance slot, so the override really gives the account its coins", async () => {
    for (const coin of [...ENTRY_COINS, ...CASH_COINS]) {
      const raw = 123n * 10n ** BigInt(coin.decimals);
      const read = await client.readContract({
        address: coin.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
        stateOverride: holding([{ coin, raw }]),
      });
      expect(read, coin.symbol).toBe(raw);
    }
  });

  it.each(CASH_COINS.map((c) => [c.symbol, c] as const))(
    "%s: approve + swap lands at least the floor in the wallet as USDC",
    async (_, coin) => {
      const c = await conversion(coin, 120n);
      const calls = buildConvertCalls({ user: holder, conversions: [c] });
      const reads = [balanceRead(coin.address), balanceRead(USDC.address)];
      const r = await client.simulateCalls({
        account: holder,
        calls: [...calls, ...reads].map(({ to, data }) => ({ to, data })),
        stateOverrides: holding([{ coin, raw: c.amountIn }]),
      });
      expect(r.results.slice(0, calls.length).map((x) => x.status)).toEqual(["success", "success"]);
      const [coinAfter, usdcAfter] = r.results.slice(calls.length).map((x) => uint(x.data));
      expect(coinAfter).toBe(0n);
      expect(usdcAfter).toBeGreaterThanOrEqual(c.minOut);
      // What Activity shows for it: the coin turned into the USDC its swap paid.
      const [item] = decodeActivity(
        r.results.flatMap((x) => x.logs ?? []),
        holder,
      );
      expect(item).toMatchObject({ kind: "convert", symbol: coin.symbol, amount: 120 });
      expect(item.receivedUsd! * 1e6).toBeCloseTo(Number(usdcAfter), -1);
    },
  );

  it("converts every coin that arrived in one batch", async () => {
    const all = await Promise.all(CASH_COINS.map((coin) => conversion(coin, 50n)));
    const calls = buildConvertCalls({ user: holder, conversions: all });
    const r = await client.simulateCalls({
      account: holder,
      calls: [...calls, balanceRead(USDC.address)].map(({ to, data }) => ({ to, data })),
      stateOverrides: holding(all.map((c) => ({ coin: c.coin, raw: c.amountIn }))),
    });
    expect(r.results.slice(0, calls.length).every((x) => x.status === "success")).toBe(true);
    expect(uint(r.results.at(-1)!.data)).toBeGreaterThanOrEqual(all.reduce((t, c) => t + c.minOut, 0n));
    expect(
      decodeActivity(
        r.results.flatMap((x) => x.logs ?? []),
        holder,
      ).map((i) => i.symbol),
    ).toEqual(CASH_COINS.map((c) => c.symbol));
  });

  it("asks for more than the venue pays and the swap reverts, so nothing converts below what was signed", async () => {
    for (const coin of CASH_COINS) {
      const c = await conversion(coin, 120n);
      const greedy = { ...c, minOut: (await quoteConvert(client, coin, c.amountIn)) + 10_000n };
      const calls = buildConvertCalls({ user: holder, conversions: [greedy] });
      const r = await client.simulateCalls({
        account: holder,
        calls: calls.map(({ to, data }) => ({ to, data })),
        stateOverrides: holding([{ coin, raw: c.amountIn }]),
      });
      expect(r.results[1].status, coin.symbol).toBe("failure");
    }
  });
});

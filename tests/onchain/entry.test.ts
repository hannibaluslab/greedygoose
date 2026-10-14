/**
 * The Entry agent's coins and venues on Base mainnet (plan item 2 step 1), read live. Nothing is signed or sent: the
 * quoters run through eth_call, the way the app quotes a buy.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi, http, parseAbi, toFunctionSelector } from "viem";
import { CHAIN } from "@/lib/chain";
import { ENTRY } from "@/config/risk";
import { SEL } from "@/lib/guardian/config";
import { aeroQuoterAbi, quoterV2Abi } from "@/lib/swap/abis";
import { AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS, type EntryCoinAsset } from "@/lib/tokens/stables";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });
const factoryAbi = parseAbi(["function factory() view returns (address)"]);
const psm3Abi = parseAbi([
  "function usdc() view returns (address)",
  "function usds() view returns (address)",
  "function previewSwapExactIn(address assetIn, address assetOut, uint256 amountIn) view returns (uint256)",
]);
const bridgedAbi = parseAbi(["function l1Token() view returns (address)", "function REMOTE_TOKEN() view returns (address)"]);
const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** USDC units for `usd` dollars of `coin`, at the venue the Entry agent swaps it on. */
async function quote(coin: EntryCoinAsset, usd: bigint): Promise<bigint> {
  const amountIn = usd * 10n ** BigInt(coin.decimals);
  const v = coin.venue;
  if (v.kind === "psm3") {
    return client.readContract({ address: v.psm, abi: psm3Abi, functionName: "previewSwapExactIn", args: [coin.address, USDC.address, amountIn] });
  }
  const { result } =
    v.kind === "aerodrome"
      ? await client.simulateContract({
          address: AERODROME_V1.QUOTER,
          abi: aeroQuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: coin.address, tokenOut: USDC.address, amountIn, tickSpacing: v.tickSpacing, sqrtPriceLimitX96: 0n }],
        })
      : await client.simulateContract({
          address: UNISWAP.QUOTER_V2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: coin.address, tokenOut: USDC.address, amountIn, fee: v.fee, sqrtPriceLimitX96: 0n }],
        });
  return result[0];
}

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
    expect(await client.readContract({ address: usdt.address, abi: bridgedAbi, functionName: "l1Token" })).toBe(ETHEREUM_USDT);
    expect(await client.readContract({ address: usdbc.address, abi: bridgedAbi, functionName: "REMOTE_TOKEN" })).toBe(ETHEREUM_USDC);
    expect(await client.readContract({ address: SPARK_PSM3.PSM3, abi: psm3Abi, functionName: "usds" })).toBe(usds.address);
    expect(await client.readContract({ address: SPARK_PSM3.PSM3, abi: psm3Abi, functionName: "usdc" })).toBe(USDC.address);
  });

  it("Aerodrome's first Slipstream router and quoter are its factory's, with the tick-spacing swap", async () => {
    for (const address of [AERODROME_V1.ROUTER, AERODROME_V1.QUOTER]) {
      expect(await client.readContract({ address, abi: factoryAbi, functionName: "factory" })).toBe(AERODROME_V1.FACTORY);
    }
    expect(toFunctionSelector("exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))")).toBe(SEL.aeroSwap);
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

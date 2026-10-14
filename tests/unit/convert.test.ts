import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Log } from "viem";
import { describeActivity } from "@/components/gg/Activity";
import { decodeActivity } from "@/lib/activity/decode";
import { explainRevert } from "@/lib/aave/errors";
import { assertAllowed } from "@/lib/allowlist";
import { aeroRouterAbi, psm3Abi, swapRouter02Abi } from "@/lib/swap/abis";
import { buildConvertCalls, convertFloorRaw, faceRaw, type Conversion } from "@/lib/swap/entry";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const attacker: Address = "0x00000000000000000000000000000000000000ee";
const [USDT, USDE, USDBC, USDS] = ENTRY_COINS;
const units = (coin: (typeof ENTRY_COINS)[number], n: number) => BigInt(n) * 10n ** BigInt(coin.decimals);
const at = (coin: (typeof ENTRY_COINS)[number], n: number): Conversion => {
  const amountIn = units(coin, n);
  return { coin, amountIn, minOut: convertFloorRaw(coin, amountIn) };
};

describe("convertFloorRaw: 99.5% of face value, as the Entry job has it", () => {
  it("is face value less 0.5%, rounded up, decimals adjusted", () => {
    expect(convertFloorRaw(USDT, units(USDT, 120))).toBe(119_400_000n);
    expect(convertFloorRaw(USDE, units(USDE, 1_000))).toBe(995_000_000n);
    expect(convertFloorRaw(USDT, 1n)).toBe(1n);
    expect(faceRaw(USDS, units(USDS, 50))).toBe(50_000_000n);
  });
});

describe("buildConvertCalls: other dollars into cash, signed by the user", () => {
  it("approves each coin exactly to its own venue and swaps it into USDC for the user at the floor", () => {
    const calls = buildConvertCalls({ user, conversions: [at(USDT, 120), at(USDE, 50), at(USDBC, 10), at(USDS, 5)], nowSec: 1_000 });
    expect(calls.map((c) => c.to)).toEqual([
      USDT.address, AERODROME_V1.ROUTER,
      USDE.address, UNISWAP.SWAP_ROUTER_02,
      USDBC.address, AERODROME_V1.ROUTER,
      USDS.address, SPARK_PSM3.PSM3,
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([AERODROME_V1.ROUTER, units(USDT, 120)]);
    const aero = decodeFunctionData({ abi: aeroRouterAbi, data: calls[1].data }).args[0];
    expect(aero).toMatchObject({ tokenIn: USDT.address, tokenOut: USDC.address, tickSpacing: 1, recipient: user, amountIn: units(USDT, 120), amountOutMinimum: 119_400_000n, deadline: 1_600n });
    const multicall = decodeFunctionData({ abi: swapRouter02Abi, data: calls[3].data });
    expect(multicall.functionName).toBe("multicall");
    const inner = decodeFunctionData({ abi: swapRouter02Abi, data: (multicall.args[1] as readonly `0x${string}`[])[0] });
    expect(inner.args[0]).toMatchObject({ tokenIn: USDE.address, tokenOut: USDC.address, fee: 500, recipient: user, amountOutMinimum: 49_750_000n });
    expect(decodeFunctionData({ abi: psm3Abi, data: calls[7].data }).args).toEqual([USDS.address, USDC.address, units(USDS, 5), 4_975_000n, user, 0n]);
  });

  it("never signs for less than 99.5%, nor nothing", () => {
    const low = { ...at(USDT, 120), minOut: 119_399_999n };
    expect(() => buildConvertCalls({ user, conversions: [low] })).toThrow(/99.5%/);
    expect(() => buildConvertCalls({ user, conversions: [{ ...at(USDT, 1), amountIn: 0n }] })).toThrow(/Nothing/);
  });
});

describe("the allowlist for conversions", () => {
  const approve = (token: Address, spender: Address) => ({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1n] }),
    value: 0n,
  });
  const aeroSwap = (router: Address, tokenIn: Address, tokenOut: Address, recipient: Address) => ({
    to: router,
    data: encodeFunctionData({
      abi: aeroRouterAbi,
      functionName: "exactInputSingle",
      args: [{ tokenIn, tokenOut, tickSpacing: 1, recipient, deadline: 1n, amountIn: 1n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
    }),
    value: 0n,
  });
  const psm = (assetIn: Address, assetOut: Address, receiver: Address) => ({
    to: SPARK_PSM3.PSM3,
    data: encodeFunctionData({ abi: psm3Abi, functionName: "swapExactIn", args: [assetIn, assetOut, 1n, 1n, receiver, 0n] }),
    value: 0n,
  });

  it("approves a coin only to the venue that converts it", () => {
    expect(() => assertAllowed(user, [approve(USDT.address, AERODROME_V1.ROUTER)])).not.toThrow();
    expect(() => assertAllowed(user, [approve(USDT.address, UNISWAP.SWAP_ROUTER_02)])).toThrow(/unexpected spender/);
    expect(() => assertAllowed(user, [approve(USDS.address, AERODROME_V1.ROUTER)])).toThrow(/unexpected spender/);
    expect(() => assertAllowed(user, [approve(USDE.address, attacker)])).toThrow(/unexpected spender/);
    // USDC and the stocks still never approve the Entry venues.
    expect(() => assertAllowed(user, [approve(USDC.address, SPARK_PSM3.PSM3)])).toThrow(/unexpected spender/);
  });

  it("converts only into USDC, only for the user, and only the coins each venue converts", () => {
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDBC.address, USDC.address, user)])).not.toThrow();
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDT.address, USDC.address, attacker)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDC.address, USDT.address, user)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDS.address, USDC.address, user)])).toThrow(/unexpected arguments/);
    // The stock router never converts other dollars.
    expect(() => assertAllowed(user, [aeroSwap(AERODROME.ROUTER, USDT.address, USDC.address, user)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [psm(USDS.address, USDC.address, user)])).not.toThrow();
    expect(() => assertAllowed(user, [psm(USDS.address, USDC.address, attacker)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [psm(USDC.address, USDS.address, user)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [psm(USDT.address, USDC.address, user)])).toThrow(/unexpected arguments/);
  });

  it("keeps a conversion's own words when it reverts, not a buy's", () => {
    const [, swap] = buildConvertCalls({ user, conversions: [at(USDE, 50)] });
    const tooLittle = encodeFunctionData({ abi: [{ type: "function", name: "Error", inputs: [{ type: "string" }] }], args: ["Too little received"] });
    expect(explainRevert(tooLittle, "Not at a fair price right now.", swap)).toBe("Not at a fair price right now.");
  });
});

describe("decodeActivity: other dollars turned into cash", () => {
  const pool: Address = "0x00000000000000000000000000000000000000aa";
  const log = (address: Address, topics: ReturnType<typeof encodeEventTopics>, data: `0x${string}`) =>
    ({ address, topics, data, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false }) as unknown as Log;
  const transfer = (token: Address, from: Address, to: Address, value: bigint) =>
    log(token, encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }), encodeAbiParameters([{ type: "uint256" }], [value]));

  it("is each coin out with the USDC its swap paid in, in order, and no receive", () => {
    const logs = [
      transfer(USDC.address, pool, user, 119_830_000n),
      transfer(USDT.address, user, pool, units(USDT, 120)),
      transfer(USDS.address, user, SPARK_PSM3.PSM3, units(USDS, 5)),
      transfer(USDC.address, SPARK_PSM3.PSM3, user, 5_000_000n),
    ];
    const items = decodeActivity(logs, user);
    expect(items).toEqual([
      { kind: "convert", symbol: "USDT", amount: 120, receivedUsd: 119.83 },
      { kind: "convert", symbol: "USDS", amount: 5, receivedUsd: 5 },
    ]);
    expect(describeActivity(items[0])).toEqual({ title: "Turned USDT into cash", amount: "120 USDT · $119.83", sign: "" });
  });
});

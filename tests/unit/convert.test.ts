import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  type Log,
} from "viem";
import { describeActivity } from "@/lib/activity/describe";
import { decodeActivity } from "@/lib/activity/decode";
import { explainRevert } from "@/lib/aave/errors";
import { assertAllowed } from "@/lib/allowlist";
import { aeroRouterAbi, psm3Abi, swapRouter02Abi } from "@/lib/swap/abis";
import {
  buildConvertCalls,
  convertFloorRaw,
  faceRaw,
  rateUsable,
  type Conversion,
  type UsdRate,
} from "@/lib/swap/entry";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { USDC } from "@/lib/tokens/registry";
import { CASH_COINS, ENTRY_COINS, OTHER_COINS } from "@/lib/tokens/stables";
import { convertPlan, convertQuote, NOT_FAIR } from "@/lib/tx/plans";
import { TxStop } from "@/lib/tx/prepared";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const attacker: Address = "0x00000000000000000000000000000000000000ee";
const [USDT, USDE, USDBC, USDS] = ENTRY_COINS;
const DAI = CASH_COINS.find((c) => c.symbol === "DAI")!;
const EURC = CASH_COINS.find((c) => c.symbol === "EURC")!;
type Coin = (typeof OTHER_COINS)[number];
const units = (coin: Coin, n: number) => BigInt(n) * 10n ** BigInt(coin.decimals);
/** EUR/USD as Chainlink's Base feed read it on 2026-10-19 at 14:14Z: 1.121065, 8 decimals. */
const NOW = 1_792_419_279;
const RATE: UsdRate = { answer: 112_106_500n, updatedAt: NOW };
const at = (coin: Coin, n: number, rate?: UsdRate): Conversion => {
  const amountIn = units(coin, n);
  return { coin, amountIn, minOut: convertFloorRaw(coin, amountIn, rate, NOW), rate };
};

describe("the coins: Turn into cash's own list, and the Entry agent's left as its contract has it", () => {
  it("Turn into cash takes USDT, USDe, USDS, DAI and EURC, and no longer USDbC", () => {
    expect(CASH_COINS.map((c) => c.symbol)).toEqual(["USDT", "USDe", "USDS", "DAI", "EURC"]);
    expect(DAI).toMatchObject({ address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 });
    expect(DAI.venue).toEqual({ kind: "uniswap", router: UNISWAP.SWAP_ROUTER_02, fee: 100 });
    expect(EURC).toMatchObject({ address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6, name: "EURC" });
    expect(EURC.venue).toEqual({ kind: "aerodrome", router: AERODROME_V1.ROUTER, tickSpacing: 1 });
    expect(EURC.peg).toMatchObject({ feed: "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F", decimals: 8 });
    // The dollar coins have no rate: a dollar is a dollar.
    expect(CASH_COINS.filter((c) => c.peg).map((c) => c.symbol)).toEqual(["EURC"]);
  });

  it("the Entry agent's list is EntryJob.sol's, unchanged until the pre-launch redeploy", () => {
    expect(ENTRY_COINS.map((c) => [c.symbol, c.address, c.decimals, c.venue.kind])).toEqual([
      ["USDT", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6, "aerodrome"],
      ["USDe", "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", 18, "uniswap"],
      ["USDbC", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 6, "aerodrome"],
      ["USDS", "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", 18, "psm3"],
    ]);
    expect(ENTRY_COINS.some((c) => "peg" in c)).toBe(false);
  });

  it("the lookups know every coin of either list, once each", () => {
    expect(OTHER_COINS.map((c) => c.symbol)).toEqual(["USDT", "USDe", "USDbC", "USDS", "DAI", "EURC"]);
  });
});

describe("convertFloorRaw: 99.5% of face value, as the Entry job has it", () => {
  it("is face value less 0.5%, rounded up, decimals adjusted", () => {
    expect(convertFloorRaw(USDT, units(USDT, 120))).toBe(119_400_000n);
    expect(convertFloorRaw(USDE, units(USDE, 1_000))).toBe(995_000_000n);
    expect(convertFloorRaw(USDT, 1n)).toBe(1n);
    expect(faceRaw(USDS, units(USDS, 50))).toBe(50_000_000n);
  });

  it("DAI is held like USDT, its 18 decimals scaled down", () => {
    expect(convertFloorRaw(DAI, units(DAI, 120))).toBe(119_400_000n);
    expect(convertFloorRaw(DAI, 1n)).toBe(1n);
    expect(convertFloorRaw(DAI, 10n ** 12n)).toBe(1n);
    expect(convertFloorRaw(DAI, 10n ** 12n + 1n)).toBe(1n);
  });
});

describe("convertFloorRaw for EURC: 99.5% of its value at the euro rate, read at signing", () => {
  it("is the amount at the rate less 0.5%, rounded up", () => {
    // 120 EURC × 1.121065 × 99.5% = $133.855161
    expect(convertFloorRaw(EURC, units(EURC, 120), RATE, NOW)).toBe(133_855_161n);
    // 1,000 EURC × 1.121065 × 99.5% = $1,115.459675
    expect(convertFloorRaw(EURC, units(EURC, 1_000), RATE, NOW)).toBe(1_115_459_675n);
    // 1 unit is $0.0000011: rounded up, never down.
    expect(convertFloorRaw(EURC, 1n, RATE, NOW)).toBe(2n);
    expect(convertFloorRaw(EURC, 3n, RATE, NOW)).toBe(4n);
    expect(convertFloorRaw(EURC, 0n, RATE, NOW)).toBe(0n);
  });

  it("follows the rate: a weaker euro, a lower floor", () => {
    expect(convertFloorRaw(EURC, units(EURC, 100), { answer: 100_000_000n, updatedAt: NOW }, NOW)).toBe(99_500_000n);
  });

  it("refuses a stale, zero, negative or missing rate, with words, rather than guessing", () => {
    const words = /^The euro rate can’t be read right now\. Try again in a moment\.$/;
    const amount = units(EURC, 120);
    // Its heartbeat is an hour; two hours old is the most it may be.
    expect(convertFloorRaw(EURC, amount, { ...RATE, updatedAt: NOW - 7_200 }, NOW)).toBe(133_855_161n);
    expect(() => convertFloorRaw(EURC, amount, { ...RATE, updatedAt: NOW - 7_201 }, NOW)).toThrow(words);
    expect(() => convertFloorRaw(EURC, amount, { ...RATE, answer: 0n }, NOW)).toThrow(words);
    expect(() => convertFloorRaw(EURC, amount, { ...RATE, answer: -1n }, NOW)).toThrow(words);
    expect(() => convertFloorRaw(EURC, amount, undefined, NOW)).toThrow(words);
    expect(rateUsable(EURC, RATE, NOW)).toBe(true);
    expect(rateUsable(EURC, { ...RATE, updatedAt: NOW - 7_201 }, NOW)).toBe(false);
    expect(rateUsable(EURC, undefined, NOW)).toBe(false);
    // A dollar coin needs none.
    expect(rateUsable(USDT, undefined, NOW)).toBe(true);
  });
});

describe("buildConvertCalls: other dollars into cash, signed by the user", () => {
  it("approves each coin exactly to its own venue and swaps it into USDC for the user at the floor", () => {
    const calls = buildConvertCalls({
      user,
      conversions: [at(USDT, 120), at(USDE, 50), at(DAI, 10), at(USDS, 5)],
      nowSec: 1_000,
    });
    expect(calls.map((c) => c.to)).toEqual([
      USDT.address,
      AERODROME_V1.ROUTER,
      USDE.address,
      UNISWAP.SWAP_ROUTER_02,
      DAI.address,
      UNISWAP.SWAP_ROUTER_02,
      USDS.address,
      SPARK_PSM3.PSM3,
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([
      AERODROME_V1.ROUTER,
      units(USDT, 120),
    ]);
    const aero = decodeFunctionData({ abi: aeroRouterAbi, data: calls[1].data }).args[0];
    expect(aero).toMatchObject({
      tokenIn: USDT.address,
      tokenOut: USDC.address,
      tickSpacing: 1,
      recipient: user,
      amountIn: units(USDT, 120),
      amountOutMinimum: 119_400_000n,
      deadline: 1_600n,
    });
    const multicall = decodeFunctionData({ abi: swapRouter02Abi, data: calls[3].data });
    expect(multicall.functionName).toBe("multicall");
    const inner = decodeFunctionData({
      abi: swapRouter02Abi,
      data: (multicall.args[1] as readonly `0x${string}`[])[0],
    });
    expect(inner.args[0]).toMatchObject({
      tokenIn: USDE.address,
      tokenOut: USDC.address,
      fee: 500,
      recipient: user,
      amountOutMinimum: 49_750_000n,
    });
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[4].data }).args).toEqual([
      UNISWAP.SWAP_ROUTER_02,
      units(DAI, 10),
    ]);
    const dai = decodeFunctionData({ abi: swapRouter02Abi, data: calls[5].data });
    const daiSwap = decodeFunctionData({
      abi: swapRouter02Abi,
      data: (dai.args[1] as readonly `0x${string}`[])[0],
    });
    expect(daiSwap.args[0]).toMatchObject({
      tokenIn: DAI.address,
      tokenOut: USDC.address,
      fee: 100,
      recipient: user,
      amountIn: units(DAI, 10),
      amountOutMinimum: 9_950_000n,
    });
    expect(decodeFunctionData({ abi: psm3Abi, data: calls[7].data }).args).toEqual([
      USDS.address,
      USDC.address,
      units(USDS, 5),
      4_975_000n,
      user,
      0n,
    ]);
  });

  it("never signs for less than 99.5%, nor nothing", () => {
    const low = { ...at(USDT, 120), minOut: 119_399_999n };
    expect(() => buildConvertCalls({ user, conversions: [low] })).toThrow(/99.5%/);
    expect(() => buildConvertCalls({ user, conversions: [{ ...at(USDT, 1), amountIn: 0n }] })).toThrow(/Nothing/);
  });

  it("converts EURC on Aerodrome at the euro rate's floor, and refuses a floor under it or a rate it can't use", () => {
    const eurc = at(EURC, 120, RATE);
    const [approve, swap] = buildConvertCalls({ user, conversions: [eurc], nowSec: NOW });
    expect(approve.to).toBe(EURC.address);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([
      AERODROME_V1.ROUTER,
      units(EURC, 120),
    ]);
    expect(swap.to).toBe(AERODROME_V1.ROUTER);
    expect(decodeFunctionData({ abi: aeroRouterAbi, data: swap.data }).args[0]).toMatchObject({
      tokenIn: EURC.address,
      tokenOut: USDC.address,
      tickSpacing: 1,
      recipient: user,
      amountIn: units(EURC, 120),
      amountOutMinimum: 133_855_161n,
    });
    // Face value alone (120 USDC's worth) is under the euro's floor.
    const atFace = { ...eurc, minOut: 119_400_000n };
    expect(() => buildConvertCalls({ user, conversions: [atFace], nowSec: NOW })).toThrow(/99.5%/);
    expect(() => buildConvertCalls({ user, conversions: [{ ...eurc, minOut: 133_855_160n }], nowSec: NOW })).toThrow(
      /99.5%/,
    );
    const words = /euro rate can’t be read/;
    expect(() => buildConvertCalls({ user, conversions: [{ ...eurc, rate: undefined }], nowSec: NOW })).toThrow(words);
    expect(() => buildConvertCalls({ user, conversions: [eurc], nowSec: NOW + 7_201 })).toThrow(words);
  });

  it("no longer converts USDbC: the allowlist refuses its approve", () => {
    expect(() => buildConvertCalls({ user, conversions: [at(USDBC, 10)] })).toThrow(/unexpected target/);
  });
});

describe("the allowlist for conversions", () => {
  const approve = (token: Address, spender: Address) => ({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1n] }),
    value: 0n,
  });
  const aeroSwap = (router: Address, tokenIn: Address, tokenOut: Address, recipient: Address, tickSpacing = 1) => ({
    to: router,
    data: encodeFunctionData({
      abi: aeroRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          tickSpacing,
          recipient,
          deadline: 1n,
          amountIn: 1n,
          amountOutMinimum: 1n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    value: 0n,
  });
  const uniSwap = (tokenIn: Address, tokenOut: Address, recipient: Address, fee: number) => ({
    to: UNISWAP.SWAP_ROUTER_02,
    data: encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [
        1n,
        [
          encodeFunctionData({
            abi: swapRouter02Abi,
            functionName: "exactInputSingle",
            args: [{ tokenIn, tokenOut, fee, recipient, amountIn: 1n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
          }),
        ],
      ],
    }),
    value: 0n,
  });
  const psm = (assetIn: Address, assetOut: Address, receiver: Address) => ({
    to: SPARK_PSM3.PSM3,
    data: encodeFunctionData({
      abi: psm3Abi,
      functionName: "swapExactIn",
      args: [assetIn, assetOut, 1n, 1n, receiver, 0n],
    }),
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
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDT.address, USDC.address, user)])).not.toThrow();
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDT.address, USDC.address, attacker)])).toThrow(
      /unexpected arguments/,
    );
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDC.address, USDT.address, user)])).toThrow(
      /unexpected arguments/,
    );
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDS.address, USDC.address, user)])).toThrow(
      /unexpected arguments/,
    );
    // The stock router never converts other dollars.
    expect(() => assertAllowed(user, [aeroSwap(AERODROME.ROUTER, USDT.address, USDC.address, user)])).toThrow(
      /unexpected arguments/,
    );
    expect(() => assertAllowed(user, [psm(USDS.address, USDC.address, user)])).not.toThrow();
    expect(() => assertAllowed(user, [psm(USDS.address, USDC.address, attacker)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [psm(USDC.address, USDS.address, user)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [psm(USDT.address, USDC.address, user)])).toThrow(/unexpected arguments/);
  });

  it("converts DAI only on Uniswap's 0.01% pool and EURC only on Aerodrome's, into USDC, for the user", () => {
    const ok = (call: { to: Address; data: `0x${string}`; value: bigint }) =>
      expect(() => assertAllowed(user, [call])).not.toThrow();
    const no = (call: { to: Address; data: `0x${string}`; value: bigint }, why: RegExp) =>
      expect(() => assertAllowed(user, [call])).toThrow(why);
    ok(approve(DAI.address, UNISWAP.SWAP_ROUTER_02));
    ok(uniSwap(DAI.address, USDC.address, user, 100));
    ok(approve(EURC.address, AERODROME_V1.ROUTER));
    ok(aeroSwap(AERODROME_V1.ROUTER, EURC.address, USDC.address, user));
    // To anyone else.
    no(uniSwap(DAI.address, USDC.address, attacker, 100), /unexpected arguments/);
    no(aeroSwap(AERODROME_V1.ROUTER, EURC.address, USDC.address, attacker), /unexpected arguments/);
    no(approve(DAI.address, attacker), /unexpected spender/);
    no(approve(EURC.address, attacker), /unexpected spender/);
    // At another venue, or another pool of the same one.
    no(approve(DAI.address, AERODROME_V1.ROUTER), /unexpected spender/);
    no(approve(EURC.address, UNISWAP.SWAP_ROUTER_02), /unexpected spender/);
    no(uniSwap(DAI.address, USDC.address, user, 500), /unexpected arguments/);
    no(uniSwap(DAI.address, USDC.address, user, 3000), /unexpected arguments/);
    no(aeroSwap(AERODROME_V1.ROUTER, DAI.address, USDC.address, user), /unexpected arguments/);
    no(uniSwap(EURC.address, USDC.address, user, 100), /unexpected arguments/);
    no(aeroSwap(AERODROME_V1.ROUTER, EURC.address, USDC.address, user, 50), /unexpected arguments/);
    no(aeroSwap(AERODROME.ROUTER, EURC.address, USDC.address, user), /unexpected arguments/);
    no(psm(DAI.address, USDC.address, user), /unexpected arguments/);
    no(psm(EURC.address, USDC.address, user), /unexpected arguments/);
    // Only into USDC.
    no(uniSwap(DAI.address, USDT.address, user, 100), /unexpected arguments/);
    no(aeroSwap(AERODROME_V1.ROUTER, EURC.address, USDT.address, user), /unexpected arguments/);
    // USDe keeps its own pool (0.05%), USDT its own tick spacing.
    ok(uniSwap(USDE.address, USDC.address, user, 500));
    no(uniSwap(USDE.address, USDC.address, user, 100), /unexpected arguments/);
    no(aeroSwap(AERODROME_V1.ROUTER, USDT.address, USDC.address, user, 50), /unexpected arguments/);
  });

  it("no longer converts USDbC for the user", () => {
    expect(() => assertAllowed(user, [approve(USDBC.address, AERODROME_V1.ROUTER)])).toThrow(/unexpected target/);
    expect(() => assertAllowed(user, [aeroSwap(AERODROME_V1.ROUTER, USDBC.address, USDC.address, user)])).toThrow(
      /unexpected arguments/,
    );
  });

  it("keeps a conversion's own words when it reverts, not a buy's", () => {
    const [, swap] = buildConvertCalls({ user, conversions: [at(USDE, 50)] });
    const tooLittle = encodeFunctionData({
      abi: [{ type: "function", name: "Error", inputs: [{ type: "string" }] }],
      args: ["Too little received"],
    });
    expect(explainRevert(tooLittle, "Not at a fair price right now.", swap)).toBe("Not at a fair price right now.");
  });
});

describe("decodeActivity: other dollars turned into cash", () => {
  const pool: Address = "0x00000000000000000000000000000000000000aa";
  const log = (address: Address, topics: ReturnType<typeof encodeEventTopics>, data: `0x${string}`) =>
    ({
      address,
      topics,
      data,
      blockHash: null,
      blockNumber: null,
      logIndex: null,
      transactionHash: null,
      transactionIndex: null,
      removed: false,
    }) as unknown as Log;
  const transfer = (token: Address, from: Address, to: Address, value: bigint) =>
    log(
      token,
      encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
      encodeAbiParameters([{ type: "uint256" }], [value]),
    );

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
    const eurc = decodeActivity(
      [transfer(EURC.address, user, pool, units(EURC, 120)), transfer(USDC.address, pool, user, 134_400_000n)],
      user,
    );
    expect(eurc).toEqual([{ kind: "convert", symbol: "EURC", amount: 120, receivedUsd: 134.4 }]);
    expect(describeActivity(eurc[0])).toMatchObject({ title: "Turned EURC into cash", amount: "120 EURC · $134.40" });
    const dai = decodeActivity(
      [transfer(DAI.address, user, pool, units(DAI, 50)), transfer(USDC.address, pool, user, 49_990_000n)],
      user,
    );
    expect(dai).toEqual([{ kind: "convert", symbol: "DAI", amount: 50, receivedUsd: 49.99 }]);
    expect(describeActivity(items[0])).toEqual({
      title: "Turned USDT into cash",
      amount: "120 USDT · $119.83",
      sign: "",
    });
  });
});

describe("convertQuote: a coin's floor and whether its venue pays it", () => {
  it("holds EURC to the rate it read, and waits when there's no usable rate", () => {
    const q = convertQuote({ coin: EURC, amountIn: units(EURC, 120), outRaw: 134_000_000n, rate: RATE, nowSec: NOW });
    expect(q).toMatchObject({ minOut: 133_855_161n, fair: true, rate: RATE });
    const under = convertQuote({
      coin: EURC,
      amountIn: units(EURC, 120),
      outRaw: 133_855_160n,
      rate: RATE,
      nowSec: NOW,
    });
    expect(under.fair).toBe(false);
    const stale = convertQuote({
      coin: EURC,
      amountIn: units(EURC, 120),
      outRaw: 134_000_000n,
      rate: RATE,
      nowSec: NOW + 7_201,
    });
    expect(stale).toMatchObject({ fair: false, minOut: 0n });
    expect(convertQuote({ coin: EURC, amountIn: units(EURC, 120), outRaw: 134_000_000n, nowSec: NOW }).fair).toBe(
      false,
    );
  });

  it("holds a dollar coin to face value, with no rate", () => {
    expect(convertQuote({ coin: DAI, amountIn: units(DAI, 10), outRaw: 9_999_000n, nowSec: NOW })).toMatchObject({
      minOut: 9_950_000n,
      fair: true,
    });
  });
});

describe("convertPlan at signing: the euro rate read again", () => {
  afterEach(() => vi.useRealTimers());
  /** Base as the plan reads it: the coin's balance, what the venue pays, and the feed's latest round (or none). */
  const base = (p: { balance: bigint; out: bigint; rate?: UsdRate }) =>
    ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "balanceOf") return p.balance;
        if (!p.rate) throw new Error("feed down");
        return [1n, p.rate.answer, 0n, BigInt(p.rate.updatedAt), 1n];
      },
      simulateContract: async () => ({ result: [p.out, 0n, 0, 0n] }),
    }) as never;
  const quoted = convertQuote({
    coin: EURC,
    amountIn: units(EURC, 120),
    outRaw: 135_000_000n,
    rate: RATE,
    nowSec: NOW,
  });
  const sign = (client: never) => {
    const invalidateQueries = vi.fn();
    vi.useFakeTimers({ now: NOW * 1000 });
    const { calls } = convertPlan(user, [quoted], client, { invalidateQueries } as never)!;
    return { calls: typeof calls === "function" ? calls() : Promise.resolve(calls), invalidateQueries };
  };
  const signedFloor = async (calls: Promise<readonly { data: `0x${string}` }[]>) => {
    const [, swap] = await calls;
    return decodeFunctionData({ abi: aeroRouterAbi, data: swap.data }).args[0].amountOutMinimum;
  };

  it("raises the floor to a rate that rose since the quote", async () => {
    const rose = { answer: 113_000_000n, updatedAt: NOW };
    const { calls } = sign(base({ balance: units(EURC, 120), out: 135_000_000n, rate: rose }));
    // 120 × 1.13 × 99.5% = $134.922
    expect(await signedFloor(calls)).toBe(134_922_000n);
  });

  it("never lowers it to a rate that fell", async () => {
    const fell = { answer: 111_000_000n, updatedAt: NOW };
    const { calls } = sign(base({ balance: units(EURC, 120), out: 135_000_000n, rate: fell }));
    expect(await signedFloor(calls)).toBe(133_855_161n);
  });

  it("stops with words when the rate can't be read or is too old, and reads the quotes again", async () => {
    const down = sign(base({ balance: units(EURC, 120), out: 135_000_000n }));
    await expect(down.calls).rejects.toThrow(TxStop);
    await expect(down.calls).rejects.toThrow("The euro rate can’t be read right now. Try again in a moment.");
    expect(down.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["convertQuote"] });
    const old = sign(base({ balance: units(EURC, 120), out: 135_000_000n, rate: { ...RATE, updatedAt: NOW - 7_201 } }));
    await expect(old.calls).rejects.toThrow(/euro rate/);
  });

  it("stops when the venue no longer pays the raised floor", async () => {
    const rose = { answer: 113_000_000n, updatedAt: NOW };
    const { calls } = sign(base({ balance: units(EURC, 120), out: 134_900_000n, rate: rose }));
    await expect(calls).rejects.toThrow(NOT_FAIR);
  });
});

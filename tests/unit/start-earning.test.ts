import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  type Log,
} from "viem";
import { describeActivity } from "@/lib/activity/describe";
import { CASH } from "@/config/risk";
import { buildRepayCalls, type Call } from "@/lib/aave/tx";
import { decodeActivity } from "@/lib/activity/decode";
import type { AgentStatus } from "@/lib/agents/status";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, payFromCash, type Cash } from "@/lib/cash";
import { cashRows, ownCashRow, type OwnMove } from "@/lib/cashActivity";
import { AGENTS_LIVE } from "@/lib/agents/config";
import {
  saveGrantFollows,
  startedEarningText,
  startEarningShown,
  startEarningSteps,
  startEarningText,
} from "@/lib/cashSetup";
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { buildSendCalls } from "@/lib/send";
import {
  assertStartEarning,
  buildStartEarningCalls,
  MIN_START_USD,
  startEarningActivity,
  startEarningMinRaw,
  startEarningPlan,
  startEarningRaw,
} from "@/lib/startEarning";
import { buildBuyCalls, type BuyQuote } from "@/lib/swap/buy";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { TxStop } from "@/lib/tx/prepared";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const other: Address = "0x00000000000000000000000000000000000000ee";
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

/** The batch's two calls, decoded: [spender, allowance] and [asset, amount, onBehalfOf, referral]. */
function decodeBatch(calls: { to: Address; data: `0x${string}` }[]) {
  const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
  const supply = decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[1].data });
  return { approve, supply };
}

/** A wallet read at signing that finds what the screen showed. */
const same = async () => usdc(10);

describe("Start earning's batch: the wallet's cash into savings, the fee buffer kept", () => {
  it("is an exact USDC approve to Aave V3's pool, then its supply of that amount for the user, referral 0", () => {
    const walletRaw = usdc(42.251674);
    const calls = buildStartEarningCalls({ user, walletRaw });
    expect(calls.map((c) => c.to)).toEqual([USDC.address, PROTOCOLS.AAVE_V3_POOL]);
    expect(calls.every((c) => c.value === 0n)).toBe(true);
    const { approve, supply } = decodeBatch(calls);
    expect(approve.functionName).toBe("approve");
    expect(supply.functionName).toBe("supply");
    const [spender, allowance] = approve.args as readonly [Address, bigint];
    const [asset, amount, onBehalfOf, referral] = supply.args as readonly [Address, bigint, Address, number];
    expect(spender).toBe(PROTOCOLS.AAVE_V3_POOL);
    // Approve exactly what's supplied: never more, never unlimited.
    expect(allowance).toBe(amount);
    expect(asset).toBe(USDC.address);
    expect(onBehalfOf).toBe(user);
    expect(referral).toBe(0);
    // Everything but the fee buffer goes in; the buffer stays for JAW's network fee.
    expect(amount).toBe(walletRaw - feeBufferRaw);
    expect(walletRaw - amount).toBe(BigInt(Math.round(CASH.feeBufferUsd * 1e6)));
  });

  it("puts in $1 at least: under $1 plus the buffer there's no batch", () => {
    expect(startEarningMinRaw).toBe(usdc(MIN_START_USD) + feeBufferRaw);
    expect(startEarningRaw(startEarningMinRaw)).toBe(usdc(MIN_START_USD));
    expect(startEarningRaw(startEarningMinRaw - 1n)).toBeNull();
    expect(startEarningRaw(0n)).toBeNull();
    expect(() => buildStartEarningCalls({ user, walletRaw: startEarningMinRaw - 1n })).toThrow(/smallest/);
    expect(startEarningPlan(user, startEarningMinRaw - 1n, same)).toBeNull();
  });

  it("is keyed by the account and the wallet on screen, and reads in Activity as one move while it confirms", async () => {
    const a = startEarningPlan(user, usdc(10), async () => usdc(10))!;
    expect(a.key).toBe(startEarningPlan(user, usdc(10), same)!.key);
    expect(a.key).not.toBe(startEarningPlan(user, usdc(10.01), same)!.key);
    expect(a.key).not.toBe(startEarningPlan(other, usdc(10), same)!.key);
    expect(a.user).toBe(user);
    expect(a.healthFloor).toBeUndefined();
    expect(a.activity).toEqual([{ kind: "save", symbol: "USDC", amount: 10 - CASH.feeBufferUsd }]);
    const calls = typeof a.calls === "function" ? await a.calls() : a.calls;
    expect(calls).toEqual(buildStartEarningCalls({ user, walletRaw: usdc(10) }));
  });

  it("builds from the wallet read again at signing, never more than the screen showed, and stops under the minimum", async () => {
    const calls = async (fresh: bigint) => {
      const read = vi.fn(async () => fresh);
      const plan = startEarningPlan(user, usdc(10), read)!;
      const built = await (plan.calls as () => Promise<Call[]>)();
      expect(read).toHaveBeenCalledWith(user);
      return built;
    };
    // The wallet fell since the 15-second read: the batch puts in what's there, and the fee buffer stays.
    expect(await calls(usdc(4))).toEqual(buildStartEarningCalls({ user, walletRaw: usdc(4) }));
    // More came in: the batch is still the screen's amount, not more.
    expect(await calls(usdc(20))).toEqual(buildStartEarningCalls({ user, walletRaw: usdc(10) }));
    // Under the smallest amount now: stopped with plain words, before JAW's sheet.
    await expect(calls(startEarningMinRaw - 1n)).rejects.toBeInstanceOf(TxStop);
    await expect(calls(0n)).rejects.toThrow(/Your cash moved/);
  });

  it("refuses a batch that differs from the screen", () => {
    const amount = usdc(5);
    const [approve, supply] = buildStartEarningCalls({ user, walletRaw: amount + feeBufferRaw });
    const approveOf = (spender: Address, raw: bigint, token: Address = USDC.address) => ({
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, raw] }),
      value: 0n,
    });
    const supplyOf = (asset: Address, raw: bigint, onBehalfOf: Address, referral = 0) => ({
      to: PROTOCOLS.AAVE_V3_POOL,
      data: encodeFunctionData({
        abi: aaveV3PoolAbi,
        functionName: "supply",
        args: [asset, raw, onBehalfOf, referral],
      }),
      value: 0n,
    });
    expect(assertStartEarning(user, [approve, supply], amount)).toHaveLength(2);
    expect(() => assertStartEarning(user, [approve, supply], amount + 1n)).toThrow(/approval differs/);
    expect(() => assertStartEarning(user, [approveOf(PROTOCOLS.AAVE_V3_POOL, amount + 1n), supply], amount)).toThrow(
      /approval differs/,
    );
    expect(() => assertStartEarning(user, [approveOf(other, amount), supply], amount)).toThrow(/approval differs/);
    expect(() =>
      assertStartEarning(user, [approveOf(PROTOCOLS.AAVE_V3_POOL, amount, nvda.address), supply], amount),
    ).toThrow(/approval differs/);
    expect(() => assertStartEarning(user, [approve, supplyOf(USDC.address, amount, other)], amount)).toThrow(
      /what earns differs/,
    );
    expect(() => assertStartEarning(user, [approve, supplyOf(USDC.address, amount - 1n, user)], amount)).toThrow(
      /what earns differs/,
    );
    expect(() => assertStartEarning(user, [approve, supplyOf(USDC.address, amount, user, 7)], amount)).toThrow(
      /what earns differs/,
    );
    expect(() => assertStartEarning(user, [supply, approve], amount)).toThrow(/approval differs/);
    expect(() => assertStartEarning(user, [approve, supply, approve], amount)).toThrow(/differs from the screen/);
    expect(() => assertStartEarning(user, [approve, { ...supply, value: 1n }], amount)).toThrow(
      /differs from the screen/,
    );
  });
});

describe("Start earning on Home: when the card shows, what it says, how many JAW sheets", () => {
  const STATUSES: AgentStatus[] = ["unconfigured", "loading", "off", "starting", "on"];
  const at = (n: number) => usdc(n);

  it("no executor (the public link): whenever $1 plus the buffer sits idle in the wallet", () => {
    expect(startEarningShown("unconfigured", startEarningMinRaw)).toBe(true);
    expect(startEarningShown("unconfigured", at(42.25))).toBe(true);
    expect(startEarningShown("unconfigured", startEarningMinRaw - 1n)).toBe(false);
    expect(startEarningShown("unconfigured", 0n)).toBe(false);
  });

  it("with an executor: only while the Save grant is off, never while it loads, starts or runs", () => {
    expect(STATUSES.filter((s) => startEarningShown(s, at(100)))).toEqual(["unconfigured", "off"]);
    expect(startEarningShown("off", startEarningMinRaw - 1n)).toBe(false);
  });

  it("counts the wallet only: savings already earn", () => {
    // $1,935 in savings and the fee buffer in the wallet: nothing idle to start earning on.
    expect(startEarningShown("unconfigured", at(CASH.feeBufferUsd))).toBe(false);
  });

  it(`oulina's $1.34 qualifies only once the buffer is $0.34 or less (it is $${CASH.feeBufferUsd} here)`, () => {
    expect(startEarningShown("unconfigured", at(1.34))).toBe(at(1.34) >= at(MIN_START_USD + CASH.feeBufferUsd));
  });

  it("says 'Your $X arrived' with nothing in savings, '$X isn't earning' beside savings", () => {
    expect(startEarningText({ walletUsd: 100, savingsUsd: 0, rate: "3.9%" })).toEqual({
      title: "Your $100 arrived",
      line: "Start earning 3.9% on it.",
    });
    expect(startEarningText({ walletUsd: 42.251674, savingsUsd: 1935.93, rate: "3.9%" })).toEqual({
      title: "$42.25 isn’t earning",
      line: "Start earning 3.9% on it.",
    });
    expect(startEarningText({ walletUsd: 1.36, savingsUsd: 0.004, rate: null }).title).toBe("Your $1.36 arrived");
    expect(startedEarningText("3.9%")).toBe("Your cash is earning 3.9%");
  });

  it("is one JAW sheet without an executor, three with one and no Save grant yet (its grant and registration)", () => {
    expect(startEarningSteps("unconfigured", true)).toBe(1);
    expect(startEarningSteps("off", true)).toBe(3);
    expect(saveGrantFollows("off", true)).toBe(true);
    expect(saveGrantFollows("on", true)).toBe(false);
  });

  it("never asks for the Save grant until agents are live (NEXT_PUBLIC_AGENTS_LIVE): one sheet, the batch alone", () => {
    for (const save of ["unconfigured", "off", "starting", "on", "loading"] as const) {
      expect(startEarningSteps(save, false)).toBe(1);
      expect(saveGrantFollows(save, false)).toBe(false);
    }
    expect(AGENTS_LIVE).toBe(false);
    expect(saveGrantFollows("off", AGENTS_LIVE)).toBe(false);
  });

  it("names no protocol on screen", () => {
    const words = [
      ...Object.values(startEarningText({ walletUsd: 40, savingsUsd: 10, rate: "3.9%" })),
      ...Object.values(startEarningText({ walletUsd: 40, savingsUsd: 0, rate: "3.9%" })),
      startedEarningText("3.9%"),
    ].join(" ");
    expect(words).not.toMatch(/aave|pool|supply|deposit|usdc|agent|borrow|lock/i);
  });
});

describe("Start earning in Activity and the Cash sheet: one row, not money leaving", () => {
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
  const supplyAbi = parseAbi([
    "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  ]);
  const savingsSupply = (by: Address, onBehalfOf: Address, amount: bigint) =>
    log(
      PROTOCOLS.AAVE_V3_POOL,
      encodeEventTopics({
        abi: supplyAbi,
        eventName: "Supply",
        args: { reserve: USDC.address, onBehalfOf, referralCode: 0 },
      }),
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [by, amount]),
    );
  /** The batch's receipt: USDC from the wallet to the savings token, and the pool's Supply for the user, by the user. */
  const receipt = (raw: bigint, by: Address = user) => [
    transfer(USDC.address, user, PROTOCOLS.AUSDC, raw),
    savingsSupply(by, user, raw),
  ];

  it("decodes as one 'save' move: no send, no receive", () => {
    const items = decodeActivity(receipt(usdc(41.751674)), user);
    expect(items).toEqual([{ kind: "save", symbol: "USDC", amount: 41.751674 }]);
    expect(describeActivity(items[0])).toEqual({ title: "Started earning", amount: "$41.75 earning", sign: "" });
    // The same as what Activity shows while it confirms.
    expect(startEarningActivity(usdc(41.751674))).toEqual(items);
  });

  it("a sale whose cash goes straight into savings is the sale alone, not a Start earning too", () => {
    const stock = EQUITIES[0];
    const items = decodeActivity(
      [
        transfer(stock.address, user, other, 10n ** BigInt(stock.decimals - 2)),
        transfer(USDC.address, other, user, usdc(4.58)),
        ...receipt(usdc(4.53)),
      ],
      user,
    );
    expect(items.map((i) => i.kind)).toEqual(["sell"]);
  });

  it("isn't the user's move when someone else supplied for them", () => {
    expect(decodeActivity(receipt(usdc(10), other), user)).toEqual([]);
  });

  it("is one row in the Cash sheet: 'Started earning · $X into savings', the cash unchanged", () => {
    const move = (over: Partial<OwnMove> = {}): OwnMove => ({
      key: "k",
      time: 1_760_000_000_000,
      status: "done",
      items: [{ kind: "save", symbol: "USDC", amount: 41.75 }],
      ...over,
    });
    const row = ownCashRow(move())!;
    expect([row.title, row.line, row.usd]).toEqual(["Started earning", "$41.75 earning", 0]);
    expect(ownCashRow(move({ status: "pending" }))!.line).toBe("$41.75 earning · Confirming");
    expect(ownCashRow(move({ status: "failed" }))).toBeNull();
    expect(cashRows({ own: [move()], executor: [], arrivals: [], since: 0 }).map((r) => r.title)).toEqual([
      "Started earning",
    ]);
  });
});

describe("the savings supply stays Earn with stocks', Start earning's and a sale into cash's alone", () => {
  const cash: Cash = { walletRaw: usdc(40), savingsRaw: 0n, saveOn: false };
  const save = buildStartEarningCalls({ user, walletRaw: usdc(10) });

  it("no other flow's batch can carry it", () => {
    const quote: BuyQuote = { venue: "uniswap", pool: 3000, amountIn: usdc(1), amountOut: 295_545n };
    const buy = buildBuyCalls({ user, stock: nvda, quote, oraclePriceUsd: 336 });
    expect(() => payFromCash(user, quote.amountIn, cash, [...buy, ...save])).toThrow(/unexpected/);
    const repay = buildRepayCalls({ user, amountRaw: usdc(5) });
    expect(() => payFromCash(user, usdc(5), cash, [...repay, ...save])).toThrow(/unexpected/);
    const send = buildSendCalls({ user, token: USDC, to: other, amountRaw: usdc(1), cash });
    expect(() => assertAllowed(user, [...send, ...save], { sendTo: other })).toThrow(/unexpected/);
    // On its own, undeclared, it's refused too.
    expect(() => assertAllowed(user, save)).toThrow(/unexpected/);
  });

  it("only those three builders declare saveTo", () => {
    const root = join(__dirname, "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ["app", "components", "hooks", "lib", "keeper", "scripts"]) {
      try {
        walk(join(root, dir));
      } catch {
        /* not in this checkout */
      }
    }
    const declaring = files
      .filter((f) => !f.endsWith(join("lib", "allowlist.ts")))
      .filter((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .some((line) => !/^\s*(\*|\/\/)/.test(line) && /\bsaveTo\s*:/.test(line)),
      )
      .map((f) => relative(root, f))
      .sort();
    expect(declaring).toEqual([
      join("lib", "earnWithStocks.ts"),
      join("lib", "sell.ts"),
      join("lib", "startEarning.ts"),
    ]);
  });
});

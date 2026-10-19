import { describe, expect, it } from "vitest";
import { AGENTS_LIVE } from "@/lib/agents/config";
import {
  ACCEPTED_COINS_TEXT,
  arrivedCoins,
  arrivedText,
  arrivedView,
  askAutomatic,
  earningLine,
  MIN_START_USD,
  rateText,
  startEarningMinRaw,
  startEarningShown,
} from "@/lib/cashSetup";
import { CASH } from "@/config/risk";
import type { AgentStatus } from "@/lib/agents/status";
import { CASH_COINS, ENTRY_COINS } from "@/lib/tokens/stables";
import { cashBalanceReads } from "@/lib/cashSetup";

const [USDT, USDE, USDS, DAI, EURC] = CASH_COINS;
const raw = (coin: (typeof CASH_COINS)[number], n: number) =>
  BigInt(Math.round(n * 100)) * 10n ** BigInt(coin.decimals - 2);
const STATUSES: AgentStatus[] = ["unconfigured", "loading", "off", "starting", "on"];

describe("start earning: when Home offers it", () => {
  const usdc = (n: number) => BigInt(Math.round(n * 1e6));
  it("is offered on idle wallet cash with no executor, or with one while the Save grant is off; never while it loads", () => {
    expect(STATUSES.filter((s) => startEarningShown(s, usdc(100)))).toEqual(["unconfigured", "off"]);
  });

  it("waits for a cent to put in plus the fee buffer that stays: never at $0 or under the buffer", () => {
    expect(startEarningMinRaw).toBe(usdc(MIN_START_USD + CASH.feeBufferUsd));
    for (const save of ["unconfigured", "off"] as const) {
      expect(startEarningShown(save, 0n)).toBe(false);
      expect(startEarningShown(save, usdc(CASH.feeBufferUsd))).toBe(false);
      expect(startEarningShown(save, usdc(0.42))).toBe(true);
      expect(startEarningShown(save, startEarningMinRaw - 1n)).toBe(false);
      expect(startEarningShown(save, startEarningMinRaw)).toBe(true);
      expect(startEarningShown(save, usdc(100))).toBe(true);
    }
    expect(startEarningShown("on", usdc(100))).toBe(false);
  });

  it("says the live rate as the screens do", () => {
    expect(rateText(0.0391)).toBe("3.9%");
    expect(rateText(0.04249)).toBe("4.2%");
  });
});

describe("other dollars in the account", () => {
  it("are read for Turn into cash's coins, USDbC no longer among them", () => {
    const account = "0x00000000000000000000000000000000c0ffee01";
    const reads = cashBalanceReads(account);
    expect(reads.map((r) => r.address)).toEqual(CASH_COINS.map((c) => c.address));
    expect(reads.every((r) => r.functionName === "balanceOf" && r.args[0] === account)).toBe(true);
    const usdbc = ENTRY_COINS.find((c) => c.symbol === "USDbC")!;
    expect(reads.some((r) => r.address === usdbc.address)).toBe(false);
  });

  it("count from $1 of face value (1 EURC for the euro), in the order they convert", () => {
    expect(arrivedCoins(undefined)).toEqual([]);
    const list = arrivedCoins([raw(USDT, 120), raw(USDE, 0.99), raw(USDS, 5), raw(DAI, 0.5), raw(EURC, 0.99)]);
    expect(list.map((a) => [a.coin.symbol, a.raw])).toEqual([
      ["USDT", 120_000_000n],
      ["USDS", 5n * 10n ** 18n],
    ]);
    const more = arrivedCoins([0n, 0n, 0n, raw(DAI, 50), raw(EURC, 1)]);
    expect(more.map((a) => [a.coin.symbol, a.raw])).toEqual([
      ["DAI", 50n * 10n ** 18n],
      ["EURC", 1_000_000n],
    ]);
  });

  it("read as one or two amounts, or past two as their face value; with EURC among them, as their amounts", () => {
    expect(arrivedText(arrivedCoins([raw(USDT, 120), 0n, 0n, 0n, 0n]))).toBe("120 USDT");
    expect(arrivedText(arrivedCoins([raw(USDT, 120), raw(USDE, 50.5), 0n, 0n, 0n]))).toBe("120 USDT and 50.5 USDe");
    expect(arrivedText(arrivedCoins([raw(USDT, 120), raw(USDE, 50.5), raw(USDS, 1.99), 0n, 0n]))).toBe(
      "$172 in other dollars",
    );
    expect(arrivedText(arrivedCoins([0n, 0n, 0n, 0n, raw(EURC, 120)]))).toBe("120 EURC");
    expect(arrivedText(arrivedCoins([raw(USDT, 120), 0n, 0n, raw(DAI, 50), 0n]))).toBe("120 USDT and 50 DAI");
    // A euro isn't a dollar: no face value for it, its amount instead.
    expect(arrivedText(arrivedCoins([raw(USDT, 120), raw(USDE, 50.5), 0n, 0n, raw(EURC, 30)]))).toBe(
      "120 USDT, 50.5 USDe and 30 EURC",
    );
  });

  it("are asked about while the Entry agent's grant runs when it doesn't convert them (DAI, EURC)", () => {
    const usdt = arrivedCoins([raw(USDT, 120), 0n, 0n, 0n, 0n]);
    const dai = arrivedCoins([0n, 0n, 0n, raw(DAI, 50), 0n]);
    const both = arrivedCoins([raw(USDT, 120), 0n, 0n, raw(DAI, 50), raw(EURC, 30)]);
    expect(arrivedView(usdt, "on")).toMatchObject({ kind: "arriving", text: "120 USDT" });
    expect(arrivedView(dai, "on")).toMatchObject({ kind: "ask", text: "50 DAI" });
    expect(arrivedView(both, "starting")).toMatchObject({ kind: "ask", text: "50 DAI and 30 EURC" });
    expect(arrivedView(both, "off")).toMatchObject({ kind: "ask", text: "120 USDT, 50 DAI and 30 EURC" });
  });

  it("get 'Turn into cash' while nothing converts them, and only 'arriving' once something does", () => {
    const usdt = arrivedCoins([raw(USDT, 120), 0n, 0n, 0n, 0n]);
    expect(arrivedView(usdt, "off")).toMatchObject({ kind: "ask", text: "120 USDT" });
    // No executor: the user's own conversion still works.
    expect(arrivedView(usdt, "unconfigured")).toMatchObject({ kind: "ask" });
    expect(arrivedView(usdt, "on")).toMatchObject({ kind: "arriving", text: "120 USDT" });
    expect(arrivedView(usdt, "starting")).toMatchObject({ kind: "arriving" });
    expect(arrivedView(usdt, "loading")).toEqual({ kind: "none" });
    expect(arrivedView([], "off")).toEqual({ kind: "none" });
  });

  it("ask 'Do this automatically next time?' only once agents are live, with an executor and no Entry grant", () => {
    expect(STATUSES.filter((s) => askAutomatic(s, true))).toEqual(["off"]);
    // Until Chainlink approves the automation (NEXT_PUBLIC_AGENTS_LIVE), the Entry grant is never asked for.
    expect(STATUSES.filter((s) => askAutomatic(s, false))).toEqual([]);
    expect(AGENTS_LIVE).toBe(false);
    expect(askAutomatic("off", AGENTS_LIVE)).toBe(false);
  });

  it("never name an agent, a limit or a savings pot", () => {
    const words = [arrivedText(arrivedCoins([raw(USDT, 1), raw(USDE, 1), raw(USDS, 1), 0n, 0n])), rateText(0.04)].join(
      " ",
    );
    expect(words).not.toMatch(/agent|saving|receive|limit|permission|executor/i);
  });
});

describe("Add money's coins", () => {
  it("names USDC and every coin Turn into cash takes, USDbC no longer among them", () => {
    expect(ACCEPTED_COINS_TEXT).toBe("USDC, USDT, USDe, USDS, DAI or EURC");
  });
});

describe("earningLine: the Cash card's line", () => {
  it("says what earns: the agent, what's in savings, or nothing yet", () => {
    expect(earningLine(true, 0)).toBe("Always earning");
    expect(earningLine(false, 25)).toBe("$25 earning");
    expect(earningLine(false, 24.567)).toBe("$24.56 earning");
    expect(earningLine(false, 0.004)).toBe("Not earning yet");
  });
});

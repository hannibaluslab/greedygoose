import { describe, expect, it } from "vitest";
import {
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
import { ENTRY_COINS } from "@/lib/tokens/stables";

const [USDT, USDE, USDBC, USDS] = ENTRY_COINS;
const raw = (coin: (typeof ENTRY_COINS)[number], n: number) =>
  BigInt(Math.round(n * 100)) * 10n ** BigInt(coin.decimals - 2);
const STATUSES: AgentStatus[] = ["unconfigured", "loading", "off", "starting", "on"];

describe("start earning: when Home offers it", () => {
  const usdc = (n: number) => BigInt(Math.round(n * 1e6));
  it("is offered on idle wallet cash with no executor, or with one while the Save grant is off; never while it loads", () => {
    expect(STATUSES.filter((s) => startEarningShown(s, usdc(100)))).toEqual(["unconfigured", "off"]);
  });

  it("waits for $1 to put in plus the fee buffer that stays: never at $0 or dust", () => {
    expect(startEarningMinRaw).toBe(usdc(MIN_START_USD + CASH.feeBufferUsd));
    for (const save of ["unconfigured", "off"] as const) {
      expect(startEarningShown(save, 0n)).toBe(false);
      expect(startEarningShown(save, usdc(0.42))).toBe(false);
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
  it("count from $1 of face value, in the order they convert", () => {
    expect(arrivedCoins(undefined)).toEqual([]);
    const list = arrivedCoins([raw(USDT, 120), raw(USDE, 0.99), raw(USDBC, 0), raw(USDS, 5)]);
    expect(list.map((a) => [a.coin.symbol, a.raw])).toEqual([
      ["USDT", 120_000_000n],
      ["USDS", 5n * 10n ** 18n],
    ]);
  });

  it("read as one or two amounts, or past two as their face value", () => {
    expect(arrivedText(arrivedCoins([raw(USDT, 120), 0n, 0n, 0n]))).toBe("120 USDT");
    expect(arrivedText(arrivedCoins([raw(USDT, 120), raw(USDE, 50.5), 0n, 0n]))).toBe("120 USDT and 50.5 USDe");
    expect(arrivedText(arrivedCoins([raw(USDT, 120), raw(USDE, 50.5), 0n, raw(USDS, 1.99)]))).toBe(
      "$172 in other dollars",
    );
  });

  it("get 'Turn into cash' while nothing converts them, and only 'arriving' once something does", () => {
    const usdt = arrivedCoins([raw(USDT, 120), 0n, 0n, 0n]);
    expect(arrivedView(usdt, "off")).toMatchObject({ kind: "ask", text: "120 USDT" });
    // No executor: the user's own conversion still works.
    expect(arrivedView(usdt, "unconfigured")).toMatchObject({ kind: "ask" });
    expect(arrivedView(usdt, "on")).toMatchObject({ kind: "arriving", text: "120 USDT" });
    expect(arrivedView(usdt, "starting")).toMatchObject({ kind: "arriving" });
    expect(arrivedView(usdt, "loading")).toEqual({ kind: "none" });
    expect(arrivedView([], "off")).toEqual({ kind: "none" });
  });

  it("ask 'Do this automatically next time?' only with an executor and no Entry grant", () => {
    expect(STATUSES.filter(askAutomatic)).toEqual(["off"]);
  });

  it("never name an agent, a limit or a savings pot", () => {
    const words = [arrivedText(arrivedCoins([raw(USDT, 1), raw(USDE, 1), raw(USDBC, 1), 0n])), rateText(0.04)].join(
      " ",
    );
    expect(words).not.toMatch(/agent|saving|receive|limit|permission|executor/i);
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

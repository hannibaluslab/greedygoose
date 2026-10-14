import { describe, expect, it } from "vitest";
import { arrivedCoins, arrivedText, arrivedView, askAutomatic, MIN_START_USD, rateText, startEarningShown } from "@/lib/cashSetup";
import type { AgentStatus } from "@/lib/agents/status";
import { ENTRY_COINS } from "@/lib/tokens/stables";

const [USDT, USDE, USDBC, USDS] = ENTRY_COINS;
const raw = (coin: (typeof ENTRY_COINS)[number], n: number) => BigInt(Math.round(n * 100)) * 10n ** BigInt(coin.decimals - 2);
const STATUSES: AgentStatus[] = ["unconfigured", "loading", "off", "starting", "on"];

describe("start earning (the Save grant)", () => {
  it("is asked only with an executor, once it's known the account has no Save grant", () => {
    expect(STATUSES.filter((s) => startEarningShown(s, 100))).toEqual(["off"]);
  });

  it("waits for money to come in: never at $0 or dust, from $1", () => {
    expect(startEarningShown("off", 0)).toBe(false);
    expect(startEarningShown("off", 0.42)).toBe(false);
    expect(startEarningShown("off", MIN_START_USD)).toBe(true);
    expect(startEarningShown("off", 100)).toBe(true);
    expect(startEarningShown("on", 100)).toBe(false);
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
    expect(arrivedText(arrivedCoins([raw(USDT, 120), raw(USDE, 50.5), 0n, raw(USDS, 1.99)]))).toBe("$172 in other dollars");
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
    const words = [arrivedText(arrivedCoins([raw(USDT, 1), raw(USDE, 1), raw(USDBC, 1), 0n])), rateText(0.04)].join(" ");
    expect(words).not.toMatch(/agent|saving|receive|limit|permission|executor/i);
  });
});

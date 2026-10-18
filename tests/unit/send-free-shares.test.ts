import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, isAddressEqual, parseUnits } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { SEND_COPY, buildSendCalls, planSend, sendOptions, type SendData } from "@/lib/send";
import { EQUITIES } from "@/lib/tokens/registry";
import type { TradeHolding } from "@/lib/trade";

/*
 * Send on a stock that backs credit (canvas board 11): free shares only. Up to $X is what the free shares are worth;
 * shares that back credit come back with a repay first, and nothing in the batch reaches Aave.
 */
const user = "0x000000000000000000000000000000000000dEaD" as const;
const sam = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const amzn = EQUITIES.find((e) => e.symbol === "AMZNc")!;
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const price = 230.41;
const raw = (shares: number) => BigInt(Math.round(shares * 1e8));

/** The canvas's Amazon: 2.17 shares ($500) all backing, $500 owed with Apple's $600 beside it; plus `free` shares. */
const amazon = (free: number): TradeHolding => ({
  symbol: "AMZNc",
  name: "Amazon",
  priceUsd: price,
  priceRaw: parseUnits(price.toFixed(8), 8),
  freeRaw: raw(free),
  backingRaw: raw(2.17),
  freeUsd: free * price,
  backingUsd: 2.17 * price,
  freeShares: free,
  backingShares: 2.17,
  multiplier: 10n ** 18n,
  paused: false,
});
const data = (h: TradeHolding, debtUsd = 500): SendData => ({
  holdings: [h],
  cash: { walletRaw: usd(50), savingsRaw: 0n, saveOn: false },
  cashUsd: 50,
  totalBackingUsd: 2.17 * price + 600,
  avgCf: (2.17 * price * 0.73 + 600 * 0.78) / (2.17 * price + 600),
  debtUsd,
});
const recipient = { address: sam, name: "sam.justan.id", onBase: true };
const send = (d: SendData, amount: string, all = false) =>
  planSend({ asset: "AMZNc", amount, all, data: d, user, recipient, checks: {} });

describe("Send on a stock that backs credit: free shares only", () => {
  it("all of it backing: listed, not pickable, and the amount says why", () => {
    expect(sendOptions(data(amazon(0))).find((o) => o.asset === "AMZNc")!.disabled).toBe(true);
    expect(send(data(amazon(0)), "200").amountNote).toBe(SEND_COPY.allBacks("Amazon"));
  });

  it("Up to $X is the free value; MAX sends every free share and no backing", () => {
    const v = send(data(amazon(0.5)), String(Math.floor(0.5 * price * 100) / 100), true);
    expect(v.maxUsd).toBe(Math.floor(0.5 * price * 100) / 100);
    expect(v.hint).toMatchObject({ upToUsd: v.maxUsd });
    expect(v.sharesRaw).toBe(raw(0.5));
    expect(v.amountNote).toBeNull();
  });

  it("more than the free shares: that's more than your free shares", () => {
    expect(send(data(amazon(0.5)), "200").amountNote).toBe(SEND_COPY.notFree);
    expect(SEND_COPY.notFree).toBe("That’s more than your free shares.");
  });

  it("the batch is the transfer only: nothing reaches Aave", () => {
    const cash = { walletRaw: usd(50), savingsRaw: 0n, saveOn: false };
    const calls = buildSendCalls({ user, token: amzn, to: sam, amountRaw: raw(0.4), cash });
    expect(calls.some((c) => isAddressEqual(c.to, AAVE.SPOKE))).toBe(false);
    const transfer = calls.find((c) => isAddressEqual(c.to, amzn.address))!;
    expect(decodeFunctionData({ abi: erc20Abi, data: transfer.data }).args).toEqual([sam, raw(0.4)]);
  });

  it("an amount that would leave under $1 sends all of it (no dust)", () => {
    // $1.80 free: $1.50 would leave 30 cents, so every free share goes; $0.70 leaves $1.10 and stays as typed.
    const d = { ...data(amazon(1.8 / price)), debtUsd: 0, totalBackingUsd: 0 };
    expect(send(d, "1.50").sharesRaw).toBe(raw(1.8 / price));
    expect(send(d, "0.70").sharesRaw).toBeLessThan(raw(1.8 / price));
  });
});

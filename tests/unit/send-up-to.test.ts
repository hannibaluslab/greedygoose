import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, isAddressEqual, parseUnits } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { SEND_COPY, buildSendCalls, planSend, sendOptions, type SendData } from "@/lib/send";
import { EQUITIES } from "@/lib/tokens/registry";
import type { TradeHolding } from "@/lib/trade";

/*
 * Send on a stock that backs credit (canvas board 11): Up to $X, the free shares plus what the 1.12 line lets out, and
 * the shares the free ones don't cover come out of backing in the same batch, before the transfer.
 */
const user = "0x000000000000000000000000000000000000dEaD" as const;
const sam = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const amzn = EQUITIES.find((e) => e.symbol === "AMZNc")!;
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const price = 230.41;
const raw = (shares: number) => BigInt(Math.round(shares * 1e8));

/** The canvas's Amazon: 2.17 shares ($500) all backing, $500 owed with Apple's $600 beside it; plus `free` shares. */
const amazon = (free: number, cf?: number): TradeHolding => ({
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
  cf,
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
const send = (d: SendData, amount: string) =>
  planSend({ asset: "AMZNc", amount, all: false, data: d, user, recipient, checks: {} });

describe("Send Up to $X on a stock that backs credit", () => {
  it("all of it backing: listed and pickable once its factor is read, not before", () => {
    expect(sendOptions(data(amazon(0))).find((o) => o.asset === "AMZNc")!.disabled).toBe(true);
    expect(sendOptions(data(amazon(0, 0.73))).find((o) => o.asset === "AMZNc")!.disabled).toBe(false);
  });

  it("$200 of it, all from backing, within Up to: no block, the shares come out first", () => {
    const v = send(data(amazon(0, 0.73)), "200");
    expect(v.amountNote ?? null).toBeNull();
    expect(v.takeOutRaw).toBe(v.sharesRaw);
    expect(v.takeOutRaw).toBeGreaterThan(0n);
  });

  it("free shares go first: only what they don't cover comes out", () => {
    const v = send(data(amazon(0.5, 0.73)), "200");
    expect(v.takeOutRaw).toBe(v.sharesRaw - raw(0.5));
    expect(send(data(amazon(1, 0.73)), "100").takeOutRaw).toBe(0n);
  });

  it("past Up to: repay first", () => {
    // $500 owed with $1,100 backing: the line lets out $373 of Amazon, so $450 is past it.
    expect(send(data(amazon(0, 0.73)), "450").amountNote).toBe(SEND_COPY.pastLine);
    expect(SEND_COPY.pastLine).toBe("That’s more than you can send right now. Repay some first to send more.");
  });

  it("the batch takes the shares out, then transfers them, and refuses to take out more than it sends", () => {
    const cash = { walletRaw: usd(50), savingsRaw: 0n, saveOn: false };
    const calls = buildSendCalls({ user, token: amzn, to: sam, amountRaw: raw(0.8), cash, takeOutRaw: raw(0.8) });
    expect(isAddressEqual(calls[0].to, AAVE.SPOKE)).toBe(true);
    expect(decodeFunctionData({ abi: spokeAbi, data: calls[0].data }).args).toEqual([
      BigInt(amzn.reserveId),
      raw(0.8),
      user,
    ]);
    const transfer = calls.find((c) => isAddressEqual(c.to, amzn.address))!;
    expect(decodeFunctionData({ abi: erc20Abi, data: transfer.data }).args).toEqual([sam, raw(0.8)]);
    expect(() =>
      buildSendCalls({ user, token: amzn, to: sam, amountRaw: raw(0.8), cash, takeOutRaw: raw(0.9) }),
    ).toThrow();
  });

  it("an amount that would leave under $1 sends all of it (no dust)", () => {
    // $1.80 free: $1.50 would leave 30 cents, so every free share goes; $0.70 leaves $1.10 and stays as typed.
    const d = { ...data(amazon(1.8 / price)), debtUsd: 0, totalBackingUsd: 0 };
    expect(send(d, "1.50").sharesRaw).toBe(raw(1.8 / price));
    expect(send(d, "0.70").sharesRaw).toBeLessThan(raw(1.8 / price));
  });
});

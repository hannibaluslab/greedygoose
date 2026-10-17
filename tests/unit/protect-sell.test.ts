import { describe, expect, it } from "vitest";
import { PROTECT_SELL } from "@/config/risk";
import {
  planSell,
  sellAmounts,
  sellOrder,
  sellPower,
  sellSlices,
  sellTiming,
  SELL_RULE,
  type SellBook,
  type SellHolding,
} from "@/lib/agents/rules/protectSell";

const WAD = 10n ** 18n;
const ALL = 10n ** 13n;
const none: SellHolding = { sharesRaw: 0n, price: 0n, cfBps: 0n, limitRaw: 0n, poolLeftRaw: 0n };
const shares = (n: number) => BigInt(Math.round(n * 1e8));
const price = (usd: number) => BigInt(usd) * 10n ** 8n;
const usd = (raw: bigint, p: bigint) => Number((raw * p) / 10n ** 16n);
const holding = (n: number, usdPrice: number, cfBps: number, limit = ALL): SellHolding => ({
  sharesRaw: shares(n),
  price: price(usdPrice),
  cfBps: BigInt(cfBps),
  limitRaw: limit,
  poolLeftRaw: ALL,
});
/** The book with stocks at their reserve ids (AAPL 0, NVDA 5, TSLA 6) and the debt at health `hf`. */
const bookAt = (stocks: Partial<Record<number, SellHolding>>, hf: number): SellBook => {
  const all = Array.from({ length: 7 }, (_, r) => stocks[r] ?? none);
  // Health = power × 1e14 / debt (WAD), so debt = power / (1e4 × health).
  return {
    stocks: all,
    debtValue: sellPower(all) / (10n * BigInt(Math.round(hf * 1000))),
    usdcPrice: 10n ** 8n,
    usdcLeftRaw: ALL,
  };
};
/** Back to Watch at 1.2 (PROTECT_SELL.targetHf; Act is the line, 2026-10-15). */
const opts = { targetHf: (12n * WAD) / 10n, floorBps: 100n, keepMix: false, maxSliceRaw: 5_000n * 10n ** 6n };

describe("sellAmounts (Protect · sell, plan item 1)", () => {
  it("sells back to Watch at 1.2, the deploy default", () => {
    expect(opts.targetHf).toBe(BigInt(PROTECT_SELL.targetHf * 10) * 10n ** 17n);
  });

  // The protect-panel example, in Act: NVDA $4,000, AAPL $3,500, TSLA $1,500 back $6,000 of credit at health 1.084.
  const panel = (half: boolean) => {
    const h = (n: number, p: number, cf: number) => holding(n, p, cf, half ? shares(n / 2) : ALL);
    return {
      ...bookAt({ 0: h(10, 350, 7_800), 5: h(20, 200, 7_000), 6: h(5, 300, 6_500) }, 1),
      debtValue: 6_000n * 10n ** 26n,
    };
  };

  it("sells the lowest collateral factor first, then spills over at a stock's daily limit", () => {
    const take = sellAmounts(panel(true), opts);
    expect(usd(take[6], price(300))).toBe(750); // half the Tesla
    expect(usd(take[5], price(200))).toBeCloseTo(597, 0); // the rest from NVIDIA
    expect(take[0]).toBe(0n); // Apple kept
  });

  it("sells only Tesla when its limit allows the whole fix", () => {
    const take = sellAmounts(panel(false), opts);
    expect(take[5]).toBe(0n);
    expect(usd(take[6], price(300))).toBeCloseTo(1_291, 0);
  });

  it("never sells a stock with no limit, and sells nothing at the target", () => {
    const b = panel(false);
    const stocks = b.stocks.map((s, r) => (r === 6 ? { ...s, limitRaw: 0n } : s));
    const take = sellAmounts({ ...b, stocks }, opts);
    expect(take[6]).toBe(0n);
    expect(take[5]).toBeGreaterThan(0n);
    expect(sellAmounts(bookAt({ 5: holding(20, 200, 7_000) }, 1.2), opts).every((t) => t === 0n)).toBe(true);
  });

  it("keeps the mix: the same share of each holding", () => {
    const take = sellAmounts(panel(false), { ...opts, keepMix: true });
    const share = (r: number, n: number) => Number(take[r]) / 1e8 / n;
    expect(share(0, 10)).toBeCloseTo(share(6, 5), 6);
    expect(share(5, 20)).toBeCloseTo(share(6, 5), 6);
  });

  it("ranks near-ties (within a point) by the larger holding", () => {
    const b = bookAt({ 6: holding(1, 300, 6_500), 3: holding(5, 700, 6_550) }, 1.2);
    const order = sellOrder(b.stocks);
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(6));
  });
});

describe("sellSlices", () => {
  it("takes more slices the deeper in Act, as one withdrawal would breach Aave's floor", () => {
    const at = (hf: number) => planSell(bookAt({ 5: holding(10, 200, 7_000) }, hf), opts).slices.length;
    expect(at(1.08)).toBe(2);
    expect(at(1.05)).toBe(3);
    expect(at(1.04)).toBe(4);
  });

  it("keeps the health above Aave's floor after every withdrawal, six slices a run", () => {
    const b = bookAt({ 5: holding(200, 200, 7_000) }, 1.01);
    const o = { ...opts, floorBps: 300n, maxSliceRaw: 50_000n * 10n ** 6n };
    const slices = sellSlices(b, sellAmounts(b, o), o);
    expect(slices).toHaveLength(SELL_RULE.maxSlices);
    let power = sellPower(b.stocks);
    let debt = b.debtValue;
    for (const s of slices) {
      power -= 7_000n * s.sharesRaw * price(200) * 10n ** 10n;
      expect(power * 10n ** 14n >= SELL_RULE.withdrawFloorHf * debt).toBe(true);
      debt -= s.minOutRaw * 10n ** 20n;
    }
  });

  it("repays exactly each swap's minimum: Aave's price less the floor", () => {
    const b = bookAt({ 5: holding(10, 200, 7_000) }, 1.08);
    const { slices, repayRaw } = planSell(b, opts);
    expect(slices).toHaveLength(2);
    for (const s of slices) expect(s.minOutRaw).toBe((s.sharesRaw * price(200) * 9_900n) / 10n ** 14n);
    expect(repayRaw).toBe(slices[0].minOutRaw + slices[1].minOutRaw);
  });
});

describe("sellTiming (decision 3, Act is the line)", () => {
  const wad = (x: number) => BigInt(Math.round(x * 1000)) * 10n ** 15n;
  const l = {
    headsUpHf: wad(PROTECT_SELL.headsUpHf),
    nowHf: wad(PROTECT_SELL.nowHf),
    headsUpDelaySec: BigInt(PROTECT_SELL.headsUpDelaySec),
  };
  const at = wad;

  it("sends a heads-up in Act, sells 30 minutes later, and at once below 1.05", () => {
    expect(sellTiming(at(1.08), 0n, 1_000n, false, l)).toEqual({ timing: "heads-up", atOnce: false });
    expect(sellTiming(at(1.08), 1_000n, 2_799n, false, l)).toEqual({ timing: "wait", atOnce: false });
    expect(sellTiming(at(1.08), 1_000n, 2_800n, false, l)).toEqual({ timing: "sell", atOnce: false });
    expect(sellTiming(at(1.049), 0n, 1_000n, false, l)).toEqual({ timing: "sell", atOnce: true });
  });

  it("does nothing in Watch: no heads-up at 1.3, nor at the line", () => {
    expect(sellTiming(at(1.3), 0n, 1_000n, false, l)).toEqual({ timing: "wait", atOnce: false });
    expect(sellTiming(at(1.1), 0n, 1_000n, false, l)).toEqual({ timing: "wait", atOnce: false });
    expect(sellTiming(at(1.2), 1_000n, 9_000n, false, l)).toEqual({ timing: "clear", atOnce: false }); // a heads-up from Act is cleared, not sold
  });

  it("never sells while prices are held, and clears a heads-up once back above the line", () => {
    expect(sellTiming(at(1.04), 0n, 1_000n, true, l).timing).toBe("wait");
    expect(sellTiming(at(1.15), 1_000n, 1_000n, true, l).timing).toBe("clear");
  });
});

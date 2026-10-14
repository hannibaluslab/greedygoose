import { describe, expect, it } from "vitest";
import { fromCoinRow, type CoinRow } from "@/lib/prices/coingecko";
import { jawMarketData } from "@/lib/prices/jaw";
import {
  PRICE_TOLERANCE, RANGES, agreesWithAave, checked, checkedLine, dayChange, downsample, isRange, moveUsd, pickMarketData, weekValue,
  type MarketData,
} from "@/lib/prices/market";
const line = (from: number, to: number, n = 24) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const data = (price: number, change = 0.01, week = line(price * 0.95, price, 169)): MarketData => ({
  price, change, day: line(price / (1 + change), price), week,
});

// Aave's oracle on Base, 2026-10-14 (getReservePrice, 8 decimals), and what JAW's /markets answered the same hour.
const AAVE = { NVDAc: 229.15, METAc: 767.02, AAPLc: 342.1 };

describe("agreesWithAave (within 2% of the oracle)", () => {
  it("accepts a price up to 2% either side", () => {
    expect(agreesWithAave(229.46, AAVE.NVDAc)).toBe(true);
    expect(PRICE_TOLERANCE).toBe(0.02);
    expect(agreesWithAave(101.99, 100)).toBe(true);
    expect(agreesWithAave(98.01, 100)).toBe(true);
  });

  it("rejects a price more than 2% off", () => {
    expect(agreesWithAave(102.1, 100)).toBe(false);
    expect(agreesWithAave(97.9, 100)).toBe(false);
  });

  it("rejects JAW's META, another token at about $5", () => {
    expect(agreesWithAave(5.38, AAVE.METAc)).toBe(false);
  });

  it("rejects missing, zero and non-finite prices on either side", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(agreesWithAave(bad, 100)).toBe(false);
      expect(agreesWithAave(100, bad)).toBe(false);
    }
  });
});

describe("checked", () => {
  it("keeps data whose price and last weekly price agree with Aave's", () => {
    const d = data(229.46);
    expect(checked(d, AAVE.NVDAc)).toBe(d);
  });

  it("drops data whose week ends on another token's price", () => {
    expect(checked(data(229.46, 0.01, line(5, 5.4, 169)), AAVE.NVDAc)).toBeUndefined();
  });

  it("drops data with no line to draw or an impossible change", () => {
    expect(checked({ ...data(229.46), day: [229.46] }, AAVE.NVDAc)).toBeUndefined();
    expect(checked({ ...data(229.46), week: [] }, AAVE.NVDAc)).toBeUndefined();
    expect(checked({ ...data(229.46), change: Number.NaN }, AAVE.NVDAc)).toBeUndefined();
    expect(checked({ ...data(229.46), change: -1 }, AAVE.NVDAc)).toBeUndefined();
    expect(checked(undefined, AAVE.NVDAc)).toBeUndefined();
  });
});

describe("pickMarketData: JAW first, CoinGecko for what JAW gets wrong", () => {
  const held = [
    { symbol: "NVDAc", priceUsd: AAVE.NVDAc },
    { symbol: "METAc", priceUsd: AAVE.METAc },
  ];

  it("asks CoinGecko only for the stock whose JAW price is off", () => {
    const jaw = { NVDAc: data(229.46), METAc: data(5.38) };
    const { data: picked, missing } = pickMarketData(held, jaw);
    expect(Object.keys(picked)).toEqual(["NVDAc"]);
    expect(missing).toEqual(["METAc"]);
  });

  it("takes CoinGecko's answer when it agrees with Aave's", () => {
    const jaw = { NVDAc: data(229.46), METAc: data(5.38) };
    const fallback = { METAc: data(766.12) };
    const { data: picked, missing } = pickMarketData(held, jaw, fallback);
    expect(picked.NVDAc.price).toBe(229.46);
    expect(picked.METAc.price).toBe(766.12);
    expect(missing).toEqual([]);
  });

  it("prefers JAW when both answer", () => {
    const { data: picked } = pickMarketData(held.slice(0, 1), { NVDAc: data(229.46) }, { NVDAc: data(229.43) });
    expect(picked.NVDAc.price).toBe(229.46);
  });

  it("leaves a stock blank when neither agrees with Aave", () => {
    const { data: picked, missing } = pickMarketData(held, { METAc: data(5.38) }, { METAc: data(800) });
    expect(picked.METAc).toBeUndefined();
    expect(missing).toEqual(["NVDAc", "METAc"]);
  });

  it("sends every stock to CoinGecko when JAW doesn't answer", () => {
    expect(pickMarketData(held, undefined).missing).toEqual(["NVDAc", "METAc"]);
  });
});

describe("jawMarketData", () => {
  it("keeps the stocks with both a quote and a week", () => {
    const quote = { price: 229.46, change: 0.0216, day: [224.6, 229.46] };
    const out = jawMarketData({ NVDAc: quote, AAPLc: { ...quote, price: 342.63 } }, { NVDAc: [239.5, 229.47] });
    expect(out).toEqual({ NVDAc: { ...quote, week: [239.5, 229.47] } });
  });
});

describe("today's change", () => {
  it("moveUsd: a holding worth $2,000 after +1.42% was worth 2000 / 1.0142", () => {
    expect(moveUsd(2000, 0.0142)).toBeCloseTo(2000 - 2000 / 1.0142, 10);
    expect(moveUsd(1200, -0.0058)).toBeLessThan(0);
    expect(moveUsd(500, 0)).toBe(0);
  });

  it("dayChange adds the moves and takes them as a share of yesterday's total", () => {
    // The boards' Home: NVIDIA $2,000 +1.42%, Apple $1,200 −0.58%, Tesla $1,400 +2.10%, cash $400.
    const stocks = [
      { valueUsd: 2000, change: 0.0142 },
      { valueUsd: 1200, change: -0.0058 },
      { valueUsd: 1400, change: 0.021 },
    ];
    const usd = moveUsd(2000, 0.0142) + moveUsd(1200, -0.0058) + moveUsd(1400, 0.021);
    const home = dayChange(stocks, 5000)!;
    expect(home.usd).toBeCloseTo(usd, 10);
    expect(home.pct).toBeCloseTo(usd / (5000 - usd), 10);
    // Invest: the same moves over the stocks alone, so a larger share.
    expect(dayChange(stocks, 4600)!.pct).toBeGreaterThan(home.pct);
  });

  it("is the stock's own change when one stock is the whole total", () => {
    expect(dayChange([{ valueUsd: 1000, change: 0.05 }], 1000)!.pct).toBeCloseTo(0.05, 12);
  });

  it("is null while a stock has no change, and with nothing held", () => {
    expect(dayChange([{ valueUsd: 2000, change: 0.01 }, { valueUsd: 1200 }], 3200)).toBeNull();
    expect(dayChange([], 400)).toBeNull();
  });
});

describe("weekValue", () => {
  it("ends on what the stocks are worth now, scaled by each one's prices", () => {
    const out = weekValue([
      { valueUsd: 2000, week: [180, 190, 200] },
      { valueUsd: 1000, week: [110, 100, 100] },
    ])!;
    expect(out).toHaveLength(3);
    expect(out[2]).toBeCloseTo(3000, 10);
    expect(out[0]).toBeCloseTo(2000 * 0.9 + 1000 * 1.1, 10);
    expect(out[1]).toBeCloseTo(2000 * 0.95 + 1000, 10);
  });

  it("lines series up from the newest point and drops what the shortest lacks", () => {
    const out = weekValue([
      { valueUsd: 100, week: [1, 2, 3, 4] },
      { valueUsd: 100, week: [5, 5, 5] },
    ])!;
    expect(out).toEqual([100 * (2 / 4) + 100, 100 * (3 / 4) + 100, 200]);
  });

  it("is null while a stock has no week, or nothing is held", () => {
    expect(weekValue([{ valueUsd: 100, week: [1, 2] }, { valueUsd: 100 }])).toBeNull();
    expect(weekValue([{ valueUsd: 100, week: [1] }])).toBeNull();
    expect(weekValue([])).toBeNull();
  });
});

describe("the CoinGecko fallback (fromCoinRow)", () => {
  // The shape /coins/markets answered for METAc on 2026-10-14: 168 hourly points, the last one up to an hour old.
  const hourly = line(737, 768.65, 168);
  const row: CoinRow = { id: "meta-coinbase-tokenized-stock", current_price: 766.42, price_change_percentage_24h: 4.02241, sparkline_in_7d: { price: hourly } };

  it("takes the price and the 24-hour change CoinGecko reports, as a fraction", () => {
    const out = fromCoinRow(row)!;
    expect(out.price).toBe(766.42);
    expect(out.change).toBeCloseTo(0.0402241, 12);
  });

  it("ends both lines on the current price, the one the app checks against Aave's", () => {
    const out = fromCoinRow(row)!;
    expect(out.week).toHaveLength(169);
    expect(out.week.at(-1)).toBe(766.42);
    expect(out.day).toHaveLength(25);
    expect(out.day).toEqual(out.week.slice(-25));
    expect(checked(out, AAVE.METAc)).toBe(out);
  });

  it("drops gaps in the line and rows with no price or change", () => {
    expect(fromCoinRow({ ...row, sparkline_in_7d: { price: [700, null, 0, 760] } })!.week).toEqual([700, 760, 766.42]);
    expect(fromCoinRow({ ...row, current_price: null })).toBeNull();
    expect(fromCoinRow({ ...row, price_change_percentage_24h: undefined })).toBeNull();
  });

  it("a row with no line can't pass the check", () => {
    expect(checked(fromCoinRow({ ...row, sparkline_in_7d: null })!, AAVE.METAc)).toBeUndefined();
  });
});

describe("downsample", () => {
  it("keeps the first and newest points, evenly spaced", () => {
    const out = downsample(line(0, 168, 169), 13);
    expect(out).toHaveLength(13);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(168);
  });

  it("leaves short series alone", () => {
    expect(downsample([1, 2, 3], 7)).toEqual([1, 2, 3]);
  });
});

describe("the chart's ranges", () => {
  it("asks for a day, a week, a month and a year of history", () => {
    expect(RANGES).toEqual({ "1D": 1, "1W": 7, "1M": 30, "1Y": 365 });
  });

  it("isRange accepts those four only", () => {
    for (const r of ["1D", "1W", "1M", "1Y"]) expect(isRange(r)).toBe(true);
    for (const r of ["1H", "ALL", "1d", "toString", "", null, undefined]) expect(isRange(r)).toBe(false);
  });
});

describe("checkedLine (a chart line, checked against Aave)", () => {
  it("keeps a line that ends within 2% of Aave's price", () => {
    const month = line(212.86, 229.13, 721);
    expect(checkedLine(month, AAVE.NVDAc)).toEqual(month);
  });

  it("drops a line that ends on another token's price", () => {
    expect(checkedLine(line(5.1, 5.38, 289), AAVE.METAc)).toBeUndefined();
  });

  it("drops a line with fewer than two points, or a bad point anywhere", () => {
    expect(checkedLine([229.13], AAVE.NVDAc)).toBeUndefined();
    expect(checkedLine([], AAVE.NVDAc)).toBeUndefined();
    expect(checkedLine(undefined, AAVE.NVDAc)).toBeUndefined();
    expect(checkedLine([220, 0, 229.13], AAVE.NVDAc)).toBeUndefined();
    expect(checkedLine([220, Number.NaN, 229.13], AAVE.NVDAc)).toBeUndefined();
  });

  it("never hands back the caller's array", () => {
    const points = [220, 229.13];
    expect(checkedLine(points, AAVE.NVDAc)).not.toBe(points);
  });
});

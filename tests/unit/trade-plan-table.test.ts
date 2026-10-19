import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import type { Cash } from "@/lib/cash";
import type { BuyQuote } from "@/lib/swap/buy";
import type { SellQuote } from "@/lib/swap/sell";
import { EQUITIES } from "@/lib/tokens/registry";
import { planTrade, tradeAmount, type QuoteState, type TradeData, type TradeHolding } from "@/lib/trade";

/*
 * planTrade's outputs over a table of accounts, routes, amounts, quotes and market hours, captured before planTrade was
 * broken into steps: every case must keep the same output (a digest of it, so the snapshot stays small).
 */

const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const PRICE: Record<string, number> = {
  AAPLc: 250,
  AMZNc: 225,
  GOOGLc: 240,
  METAc: 700,
  MSFTc: 500,
  NVDAc: 200,
  TSLAc: 400,
};

function holding(symbol: string, freeUsd = 0, backingUsd = 0, paused = false): TradeHolding {
  const e = EQUITIES.find((x) => x.symbol === symbol)!;
  const p = PRICE[symbol];
  const raw = (v: number) => BigInt(Math.round((v / p) * 1e8));
  const freeRaw = raw(freeUsd);
  const backingRaw = raw(backingUsd);
  return {
    symbol,
    name: e.name,
    priceUsd: p,
    priceRaw: parseUnits(p.toFixed(8), 8),
    freeRaw,
    backingRaw,
    freeUsd: (Number(freeRaw) / 1e8) * p,
    backingUsd: (Number(backingRaw) / 1e8) * p,
    freeShares: Number(freeRaw) / 1e8,
    backingShares: Number(backingRaw) / 1e8,
    multiplier: 10n ** 18n,
    paused,
  };
}

function account(cash: Cash, held: Record<string, [number, number, boolean?]>, debt = 0): TradeData {
  const holdings = EQUITIES.map((e) => holding(e.symbol, ...(held[e.symbol] ?? [0, 0])));
  return {
    holdings,
    cash,
    cashUsd: Number(cash.walletRaw + cash.savingsRaw) / 1e6,
    totalBackingUsd: holdings.reduce((a, h) => a + h.backingUsd, 0),
    avgCf: 0.7,
    debtUsd: debt,
    debtRaw: usd(debt),
    healthFactor: debt ? (holdings.reduce((a, h) => a + h.backingUsd, 0) * 0.7) / debt : null,
  };
}

const ACCOUNTS: Record<string, TradeData> = {
  backer: account(
    { walletRaw: usd(20), savingsRaw: usd(1_919.18), saveOn: false },
    { AMZNc: [1.8, 1_721.43], GOOGLc: [0, 900], METAc: [0, 1_400], NVDAc: [0, 2_500], TSLAc: [0.09, 0] },
    2_000,
  ),
  newcomer: account(
    { walletRaw: usd(40), savingsRaw: 0n, saveOn: false },
    { AAPLc: [30, 0], AMZNc: [12, 0], NVDAc: [50, 0], TSLAc: [6, 0, true] },
  ),
  shortCash: account({ walletRaw: usd(0.04), savingsRaw: 0n, saveOn: false }, { AAPLc: [500, 0], NVDAc: [80, 20] }, 10),
  empty: account({ walletRaw: 0n, savingsRaw: 0n, saveOn: false }, {}),
};

const ROUTES: [string, string][] = [
  ["cash", "NVDAc"],
  ["cash", "AAPLc"],
  ["NVDAc", "cash"],
  ["AAPLc", "cash"],
  ["AMZNc", "cash"],
  ["TSLAc", "cash"],
  ["NVDAc", "AAPLc"],
  ["AAPLc", "NVDAc"],
  ["AMZNc", "TSLAc"],
  ["cash", "cash"],
];
const AMOUNTS = ["", "0.005", "0.5", "1", "5", "25", "100", "100000", "x"];

const ready = <Q>(data: Q, isFetching = false): QuoteState<Q> => ({ data, isFetching, isSuccess: true });
const loading: QuoteState<never> = { data: undefined, isFetching: true, isSuccess: false };
const noPool: QuoteState<never> = { data: null, isFetching: false, isSuccess: true };
const OPEN = new Date("2026-10-14T15:00:00Z");
const SATURDAY = new Date("2026-10-17T15:00:00Z");

const buyQuoteFor = (symbol: string, amountIn: bigint, premium: number): BuyQuote => ({
  venue: "aerodrome",
  pool: 10,
  amountIn,
  amountOut: BigInt(Math.floor((Number(amountIn) / 1e6 / (PRICE[symbol] * (1 + premium))) * 1e8)),
});
const sellQuoteFor = (symbol: string, sharesRaw: bigint, discount: number): SellQuote => ({
  venue: "uniswap",
  pool: 3000,
  amountIn: sharesRaw,
  amountOut: BigInt(Math.floor((Number(sharesRaw) / 1e8) * PRICE[symbol] * (1 - discount) * 1e6)),
});

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
const digest = (v: unknown) => createHash("sha256").update(json(v)).digest("hex").slice(0, 16);

type Mode = "none" | "loading" | "noPool" | "ready" | "warn" | "block" | "fetching" | "stale";
const MODES: Mode[] = ["none", "loading", "noPool", "ready", "warn", "block", "fetching", "stale"];
const PREMIUM: Partial<Record<Mode, number>> = { ready: 0.003, warn: 0.05, block: 0.2, fetching: 0.003, stale: 0.003 };

function quotesFor(mode: Mode, base: Parameters<typeof planTrade>[0]) {
  if (mode === "none") return {};
  if (mode === "loading") return { buy: loading, sell: loading };
  if (mode === "noPool") return { buy: noPool, sell: noPool };
  const p = PREMIUM[mode]!;
  const fetching = mode === "fetching";
  const a = tradeAmount(base);
  const off = mode === "stale" ? 1n : 0n;
  const sell =
    a.fromStock && a.sharesRaw > 0n
      ? ready(sellQuoteFor(a.fromStock.symbol, a.sharesRaw + off, p), fetching)
      : undefined;
  if (a.route === "buy") return { buy: ready(buyQuoteFor(a.toStock!.symbol, a.usdRaw + off, p), fetching) };
  if (a.route === "sell") return { sell };
  if (a.route === "swap") {
    const first = planTrade({ ...base, sell });
    const buy =
      first.buyInRaw > 0n ? ready(buyQuoteFor(a.toStock!.symbol, first.buyInRaw + off, p), fetching) : undefined;
    return { sell, buy };
  }
  return {};
}

describe("planTrade over a table of cases", () => {
  it("keeps every case's output", () => {
    // One digest per account, route and quote state, over every amount, MAX or not, and (ready) the weekend.
    const out: Record<string, string> = {};
    let cases = 0;
    for (const [name, data] of Object.entries(ACCOUNTS))
      for (const [from, to] of ROUTES)
        for (const mode of MODES) {
          const views: unknown[] = [];
          for (const amount of AMOUNTS)
            for (const all of [false, true])
              for (const now of mode === "ready" ? [OPEN, SATURDAY] : [OPEN]) {
                const base = { from, to, amount, all, data, now };
                views.push(planTrade({ ...base, ...quotesFor(mode, base) }));
                cases++;
              }
          out[`${name} ${from}>${to} ${mode}`] = digest(views);
        }
    expect(cases).toBeGreaterThan(5_000);
    expect(out).toMatchSnapshot();
  });
});

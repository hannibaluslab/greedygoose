import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { CASH } from "@/config/risk";
import type { Cash } from "@/lib/cash";
import { planRepay, repaySources, type RepayData, type RepayForm, type RepayHolding } from "@/lib/repay";
import type { SellQuote } from "@/lib/swap/sell";
import type { QuoteState } from "@/lib/trade";

/*
 * planRepay's outputs over a table of accounts, rows, amounts, quotes and market hours, captured before planRepay was
 * broken into steps: every case must keep the same output (a digest of it, so the snapshot stays small).
 */

const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const shares = (n: number) => parseUnits(n.toFixed(8), 8);

const holding = (symbol: string, name: string, priceUsd: number, free: number, backing: number, paused = false) =>
  ({
    symbol,
    name,
    priceUsd,
    freeRaw: shares(free),
    backingRaw: shares(backing),
    freeUsd: free * priceUsd,
    backingUsd: backing * priceUsd,
    paused,
    multiplier: 10n ** 18n,
  }) satisfies RepayHolding;

const data = (p: { debt?: number; wallet?: number; savings?: number; holdings?: RepayHolding[] } = {}): RepayData => {
  const debt = p.debt ?? 300;
  const cash: Cash = { walletRaw: usd(p.wallet ?? 100), savingsRaw: usd(p.savings ?? 0), saveOn: false };
  const healthFactor = debt > 0 ? 700 / debt : null;
  return {
    totalBackingUsd: 1_000,
    avgCf: 0.7,
    debtUsd: debt,
    debtRaw: usd(debt),
    healthFactor,
    status: healthFactor === null ? "none" : healthFactor >= 1.5 ? "safe" : healthFactor >= 1.1 ? "watch" : "act",
    cash,
    cashUsd: (p.wallet ?? 100) + (p.savings ?? 0),
    holdings: p.holdings ?? [
      holding("AAPLc", "Apple", 200, 0.5, 0),
      holding("MSFTc", "Microsoft", 400, 0.00001, 0),
      holding("NVDAc", "NVIDIA", 250, 0.1, 4),
    ],
  };
};
const cfs = { NVDAc: 0.7, AAPLc: 0.78, MSFTc: 0.7, TSLAc: 0.6 };

const ACCOUNTS: Record<string, RepayData> = {
  base: data(),
  saleFee: data({ wallet: CASH.feeBufferUsd * 0.6 }),
  watch: data({ debt: 560 }),
  tiny: data({ debt: 0.005 }),
  richCash: data({ wallet: 2_000, savings: 3_000 }),
  savings: data({ wallet: 0.02, savings: 80 }),
  paused: data({
    holdings: [holding("AAPLc", "Apple", 200, 2, 0), holding("TSLAc", "Tesla", 400, 0.05, 2, true)],
  }),
};

const AMOUNTS = ["", "0.005", "0.5", "1", "10", "50", "299", "300", "1000", "x"];
const FORMS: [string, RepayForm][] = [
  ...AMOUNTS.map((amount): [string, RepayForm] => [`"${amount}"`, { source: null, amount, all: false }]),
  ["all", { source: null, amount: "", all: true }],
  ["snapped", { source: null, amount: "", all: true, snapped: true }],
];

const ready = (q: SellQuote, isFetching = false): QuoteState<SellQuote> => ({ data: q, isFetching, isSuccess: true });
const loading: QuoteState<SellQuote> = { data: undefined, isFetching: true, isSuccess: false };
const noPool: QuoteState<SellQuote> = { data: null, isFetching: false, isSuccess: true };
const quoteAt = (stockShares: bigint, perShare: number): SellQuote => ({
  venue: "aerodrome",
  pool: 10,
  amountIn: stockShares,
  amountOut: usd((Number(stockShares) / 1e8) * perShare),
});
const TUESDAY = new Date("2026-10-13T15:00:00Z");
const SATURDAY = new Date("2026-10-17T15:00:00Z");

type Mode = "none" | "loading" | "noPool" | "maxOnly" | "ready" | "warn" | "price" | "fetching" | "stale" | "quoteNone";
const MODES: Mode[] = [
  "none",
  "loading",
  "noPool",
  "maxOnly",
  "ready",
  "warn",
  "price",
  "fetching",
  "stale",
  "quoteNone",
];
const DISCOUNT: Partial<Record<Mode, number>> = {
  maxOnly: 0.005,
  ready: 0.005,
  warn: 0.03,
  price: 0.2,
  fetching: 0.005,
  stale: 0.005,
  quoteNone: 0.005,
};

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
const digest = (v: unknown) => createHash("sha256").update(json(v)).digest("hex").slice(0, 16);

describe("planRepay over a table of cases", () => {
  it("keeps every case's output", () => {
    // One digest per account, row and quote state, over every amount, All, and (ready) the weekend.
    const out: Record<string, string> = {};
    let cases = 0;
    for (const [name, d] of Object.entries(ACCOUNTS))
      for (const source of repaySources(d, cfs))
        for (const mode of MODES) {
          const views: unknown[] = [];
          for (const [, form] of FORMS)
            for (const now of mode === "ready" ? [TUESDAY, SATURDAY] : [TUESDAY]) {
              const base = { data: d, source, form, now };
              const perShare = (source.holding?.priceUsd ?? 0) * (1 - (DISCOUNT[mode] ?? 0));
              const max = ready(quoteAt(source.maxSharesRaw, perShare));
              let quotes = {};
              if (mode === "loading") quotes = { maxQuote: loading };
              else if (mode === "noPool") quotes = { maxQuote: noPool };
              else if (mode === "maxOnly") quotes = { maxQuote: max };
              else if (mode !== "none") {
                const sharesRaw = planRepay({ ...base, maxQuote: max }).sharesRaw;
                const quote =
                  mode === "quoteNone"
                    ? noPool
                    : ready(quoteAt(sharesRaw + (mode === "stale" ? 1n : 0n), perShare), mode === "fetching");
                quotes = { maxQuote: max, quote };
              }
              views.push(planRepay({ ...base, ...quotes }));
              cases++;
            }
          out[`${name} ${source.id} ${mode}`] = digest(views);
        }
    expect(cases).toBeGreaterThan(2_000);
    expect(out).toMatchSnapshot();
  });
});

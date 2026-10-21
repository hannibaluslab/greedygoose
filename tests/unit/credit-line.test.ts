import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { ACT_LINE, creditLineFor, pastStop } from "@/config/risk";
import { protectRuns } from "@/lib/cash";
import {
  CREDIT_FLOOR,
  creditAvailable,
  creditFloor,
  planCredit,
  type BackingOption,
  type CreditPosition,
} from "@/lib/creditBuy";
import { LINE_MOVED } from "@/lib/creditBuy/copy";
import { BOARD_COPY } from "@/lib/board/copy";
import { earnOffer, earnTick } from "@/lib/earnWithStocks";
import { FREE_UP_FLOOR, freeUpFloor, planFreeUp, type FreeUpStock } from "@/lib/freeUpPlan";
import { planSell } from "@/lib/sell";
import type { SellQuote } from "@/lib/swap/sell";
import { EQUITIES } from "@/lib/tokens/registry";

/*
 * The credit line (Adrian, 2026-10-21): once Greedy Fatalities is open, credit and free up may go down toward Aave's
 * line, 1.05 with Protector on and 1.01 with it off, and a move that ends in Act asks for the tick. Until then, every
 * flow is held to ACT_LINE as before (the plan tables' snapshots pin that).
 */

const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const shares = (n: number) => parseUnits(n.toFixed(8), 8);
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const walletCash = { walletRaw: usd(40), savingsRaw: 0n, saveOn: true };
const weekday = new Date("2026-10-14T15:00:00Z");

const ON = creditLineFor({ wallOpen: true, protectOn: true });
const OFF = creditLineFor({ wallOpen: true, protectOn: false });

describe("the line", () => {
  it("is ACT_LINE until the Wall opens, whatever Protector does", () => {
    expect(creditLineFor({ wallOpen: false, protectOn: true })).toBe(ACT_LINE);
    expect(creditLineFor({ wallOpen: false, protectOn: false })).toBe(ACT_LINE);
    expect(ACT_LINE).toEqual({ capHf: 1.12, stopHf: 1.1, intoAct: false });
  });

  it("with the Wall open: 1.05 over Protector's 1.03 while it runs, 1.01 over Aave's 1.0 when it doesn't", () => {
    expect(ON).toEqual({ capHf: 1.05, stopHf: 1.03, intoAct: true });
    expect(OFF).toEqual({ capHf: 1.01, stopHf: 1, intoAct: true });
  });

  it("past the stop: only a real health under it", () => {
    expect(pastStop(1.02, ON)).toBe(true);
    expect(pastStop(1.03, ON)).toBe(false);
    expect(pastStop(null, ON)).toBe(false);
    expect(pastStop(Infinity, ON)).toBe(false);
  });

  it("Protector runs when the executor's protect job bit is set", () => {
    expect(protectRuns(0b00010)).toBe(true);
    expect(protectRuns(0b00001)).toBe(false); // Save only
    expect(protectRuns(0)).toBe(false);
  });
});

describe("taking credit (planCredit)", () => {
  // $2,000 of NVIDIA backs $1,000 owed at a 70% factor: $1,400 of power, health 1.40 (Watch).
  const at = (debtUsd: number, line?: typeof ON): CreditPosition => ({
    totalBackingUsd: 2_000,
    avgCf: 0.7,
    debtUsd,
    healthFactor: 1_400 / debtUsd,
    usdcLiquidity: 1_000_000,
    creditPaused: false,
    ...(line ? { line } : {}),
  });
  const plan = (creditUsd: number, position: CreditPosition) =>
    planCredit({ position, options: [], creditRaw: usd(creditUsd), cash: walletCash, now: weekday });

  it("the MAX is the most that keeps the health at the line's cap", () => {
    expect(plan(0, at(1_000)).maxUsd).toBe(250); // 1,400 ÷ 1.12 − 1,000
    expect(plan(0, at(1_000, ON)).maxUsd).toBe(333.33); // 1,400 ÷ 1.05 − 1,000
    expect(plan(0, at(1_000, OFF)).maxUsd).toBe(386.13); // 1,400 ÷ 1.01 − 1,000
  });

  it("ending in Act: blocked under ACT_LINE; asks for the tick once the line allows it", () => {
    expect(plan(300, at(1_000)).block).toBe("act");
    const p = plan(300, at(1_000, ON)); // health 1.08 after
    expect(p.after).toBe("act");
    expect(p.block).toBeUndefined();
    expect(p.intoAct).toBe(true);
    expect(p.extraConfirm).toBe(true);
  });

  it("past the cap is 'too-much', not 'act', once a plan may end in Act", () => {
    expect(plan(350, at(1_000, ON)).block).toBe("too-much"); // health 1.037, under 1.05
  });

  it("ending in Watch still asks for D2's tick, and isn't 'into Act'", () => {
    const p = plan(100, at(1_000, ON)); // health 1.27
    expect(p.after).toBe("watch");
    expect(p.extraConfirm).toBe(true);
    expect(p.intoAct).toBe(false);
  });

  it("already in Act: under ACT_LINE nothing more; with Protector on, more down to 1.05", () => {
    const inAct = 1_400 / 1.07;
    expect(plan(20, at(inAct)).block).toBe("in-act");
    const p = plan(20, at(inAct, ON));
    expect(p.block).toBeUndefined();
    expect(p.hfAfter).toBeGreaterThanOrEqual(1.05);
  });

  it("under the line's stop: 'past-limit', and Invest's buying power says why", () => {
    const under = at(1_400 / 1.02, ON);
    expect(plan(10, under).block).toBe("past-limit");
    const nvdaFree: BackingOption = { stock: nvda, freeRaw: shares(4), freeUsd: 1_000, cf: 0.7 };
    expect(creditAvailable({ position: under, options: [nvdaFree], cash: walletCash, holdsStock: true }).why).toBe(
      "past-limit",
    );
  });

  it("the batch is held to the line's stop, in words that say prices moved", () => {
    expect(plan(100, at(1_000)).floor).toEqual(CREDIT_FLOOR);
    expect(plan(100, at(1_000, ON)).floor).toEqual({ minHf: 1.03, stop: LINE_MOVED });
    expect(creditFloor(OFF)).toEqual({ minHf: 1, stop: LINE_MOVED });
  });

  it("the tick into Act states the Wall's rule; the Watch tick keeps its words", () => {
    expect(earnTick(plan(300, at(1_000, ON)))).toBe(BOARD_COPY.wallTick);
    expect(earnTick(plan(100, at(1_000, ON)))).toMatch(/^I understand this puts my credit in Watch/);
    expect(BOARD_COPY.wallTick).toMatch(/Greedy Fatalities\.$/);
  });

  it("Earn with stocks is closed under the stop with the same words", () => {
    const offer = earnOffer({
      options: [],
      position: at(1_400 / 1.02, ON),
      cash: walletCash,
      cashApy: 0.08,
      creditApy: 0.02,
      now: weekday,
    });
    expect(offer).toMatchObject({ kind: "closed", why: "past-limit" });
  });
});

describe("freeing stock (planFreeUp, planSell)", () => {
  // $1,000 of Amazon backs $500 owed at a 70% factor: $700 of power, health 1.40.
  const amazon: FreeUpStock = { symbol: "AMZNc", backingRaw: 4_000_000n, backingUsd: 1_000, cf: 0.7, paused: false };
  const free = (share: number, line?: typeof ON) =>
    planFreeUp({
      position: { totalBackingUsd: 1_000, avgCf: 0.7, debtUsd: 500, ...(line ? { line } : {}) },
      repayUsd: 0,
      repaysAll: false,
      stocks: [amazon],
      picks: [{ symbol: "AMZNc", share }],
    });

  it("frees up to the line's cap: 20% at 1.12, 25% at 1.05", () => {
    expect(free(1).rows[0].maxShare).toBeCloseTo(0.2, 9); // (700 − 500 × 1.12) ÷ 0.7 ÷ 1,000
    expect(free(1, ON).rows[0].maxShare).toBeCloseTo(0.25, 9); // (700 − 500 × 1.05) ÷ 0.7 ÷ 1,000
  });

  it("ending in Act once the line allows it: the tick, not Watch's", () => {
    const p = free(0.25, ON);
    expect(p.after).toBe("act");
    expect(p.intoAct).toBe(true);
    expect(p.risky).toBe(false);
    const q = free(0.25);
    expect(q.after).toBe("watch"); // held to 20% at 1.12
    expect(q.intoAct).toBe(false);
  });

  it("the take-outs are held to the line's stop", () => {
    expect(freeUpFloor()).toEqual(FREE_UP_FLOOR);
    expect(freeUpFloor(ON)).toEqual({ minHf: 1.03, stop: LINE_MOVED });
  });

  it("selling shares that back credit: out to the line's cap, into Act with the tick", () => {
    const holding = { priceUsd: 250, freeRaw: 0n, backingRaw: shares(4), backingUsd: 1_000, paused: false };
    const position = { totalBackingUsd: 1_000, avgCf: 0.7, debtUsd: 500, debtRaw: usd(500), healthFactor: 1.4 };
    const quote: SellQuote = { venue: "aerodrome", pool: 10, amountIn: shares(0.9), amountOut: usd(224) };
    const sell = (line?: typeof ON) =>
      planSell({
        from: "backing",
        stock: nvda,
        holding,
        cf: 0.7,
        position: { ...position, ...(line ? { line } : {}) },
        quote,
        now: weekday,
      });
    expect(Number(sell().maxRaw) / 1e8).toBeCloseTo(0.8, 6); // $200 of $1,000 at 1.12
    expect(sell().block).toBe("past-line");
    const p = sell(ON);
    expect(Number(p.maxRaw) / 1e8).toBeCloseTo(1, 6); // $250 at 1.05
    expect(p.block).toBeUndefined();
    expect(p.after).toBe("act"); // (700 − 225 × 0.7) ÷ 500 = 1.085
    expect(p.intoAct).toBe(true);
    expect(p.floor).toEqual({ minHf: 1.03, stop: LINE_MOVED });
  });
});

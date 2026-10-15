import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { memberFlows, peakCredit, type BoardRecord, type FlowRules, type Move } from "@/lib/board/flows";
import { MIN_PUT_IN_USD, rankRows, returnSinceJoining, type Flows } from "@/lib/board/score";
import { stockUsd6 } from "@/lib/board/worth";
import { GUARDIAN } from "@/lib/guardian/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { tokenInfo } from "@/lib/board/tokens";

/*
 * The leaderboard's number, return since joining, run through the same steps the board takes (lib/board/read.ts):
 * an account's records since joining → its moves in and out (memberFlows) → dollars → returnSinceJoining. Accounts are
 * modelled as what they hold, so net worth is computed the way worth6 does: dollars + stocks at Aave's price − owed.
 */

const SAM = "0x000000000000000000000000000000000000a11c" as Address;
const KIT = "0x000000000000000000000000000000000000b0b0" as Address;
const OUTSIDE = "0x00000000000000000000000000000000000ca5e0" as Address; // an exchange, another wallet
const POOL = "0x00000000000000000000000000000000000000f1" as Address; // a swap pool (inside)
const HUB = "0x00000000000000000000000000000000000000a4" as Address; // Aave's hub (inside)
const TREASURY = "0x0000000000000000000000000000000000000fee" as Address; // the paymaster's treasury
const NVDA = EQUITIES[5];
const JOIN = 100n;

const rules: FlowRules = {
  usdc: USDC.address,
  ausdc: GUARDIAN.AUSDC,
  token: tokenInfo,
  inside: (a) => [POOL, HUB].some((b) => b.toLowerCase() === a.toLowerCase()),
};

const usd6 = (usd: number) => BigInt(Math.round(usd * 1e6));
const priceRaw = (usd: number) => BigInt(Math.round(usd * 1e8));

/** A tiny ledger for one or more accounts: holdings, prices, and the records the chain would log. */
class Ledger {
  usd = new Map<string, bigint>();
  stock = new Map<string, bigint>();
  owed = new Map<string, bigint>();
  price = priceRaw(100);
  records: BoardRecord[] = [];
  block = JOIN;
  private log = 0;
  private txn = 0;
  private prices = new Map<bigint, bigint>();

  private get = (m: Map<string, bigint>, a: Address) => m.get(a) ?? 0n;
  private add = (m: Map<string, bigint>, a: Address, v: bigint) => m.set(a, this.get(m, a) + v);
  private tx = () => `0x${(++this.txn).toString(16).padStart(64, "0")}` as Hex;
  private base = (tx: Hex) => ({ block: this.block, tx, logIndex: this.log++ });

  /** The next block, at a new price for NVIDIA. */
  next(price = this.price) {
    this.block += 1n;
    this.price = price;
    this.prices.set(this.block, price);
    return this;
  }
  priceAt = (block: bigint) => this.prices.get(block) ?? this.price;

  worth(a: Address) {
    return Number(this.get(this.usd, a) + stockUsd6(this.get(this.stock, a), this.price) - this.get(this.owed, a)) / 1e6;
  }

  private transfer(tx: Hex, token: Address, from: Address, to: Address, value: bigint) {
    this.records.push({ kind: "transfer", ...this.base(tx), token, from, to, value });
  }

  /** Dollars arriving from outside (a deposit), or leaving to outside (a withdrawal). */
  deposit(a: Address, usd: number, from = OUTSIDE) {
    this.add(this.usd, a, usd6(usd));
    this.transfer(this.tx(), USDC.address, from, a, usd6(usd));
  }
  withdraw(a: Address, usd: number, to = OUTSIDE) {
    this.add(this.usd, a, -usd6(usd));
    this.transfer(this.tx(), USDC.address, a, to, usd6(usd));
  }
  /** One member pays another. */
  pay(from: Address, to: Address, usd: number) {
    this.add(this.usd, from, -usd6(usd));
    this.add(this.usd, to, usd6(usd));
    this.transfer(this.tx(), USDC.address, from, to, usd6(usd));
  }
  /** Buy NVIDIA at the current price through a pool, paying a USDC network fee to the paymaster's treasury. */
  buy(a: Address, usd: number, feeUsd = 0) {
    const tx = this.tx();
    const n = (usd6(usd) * 10n ** 10n) / this.price;
    this.add(this.usd, a, -usd6(usd));
    this.add(this.stock, a, n);
    this.transfer(tx, NVDA.address, POOL, a, n);
    this.transfer(tx, USDC.address, a, POOL, usd6(usd));
    if (feeUsd) this.fee(a, tx, feeUsd);
  }
  fee(a: Address, tx: Hex, feeUsd: number) {
    this.add(this.usd, a, -usd6(feeUsd));
    this.transfer(tx, USDC.address, a, TREASURY, usd6(feeUsd));
    this.records.push({ kind: "fee", ...this.base(tx), user: a, token: USDC.address, amount: usd6(feeUsd) });
  }
  /** A Credit Buy: draw `usd` of credit from Aave and buy NVIDIA with it. */
  creditBuy(a: Address, usd: number) {
    const tx = this.tx();
    this.add(this.owed, a, usd6(usd));
    this.records.push({ kind: "spoke", ...this.base(tx), event: "Borrow", reserveId: USDC.reserveId, caller: a, user: a, amount: usd6(usd) });
    this.transfer(tx, USDC.address, HUB, a, usd6(usd));
    this.add(this.usd, a, usd6(usd));
    const n = (usd6(usd) * 10n ** 10n) / this.price;
    this.add(this.usd, a, -usd6(usd));
    this.add(this.stock, a, n);
    this.transfer(tx, NVDA.address, POOL, a, n);
    this.transfer(tx, USDC.address, a, POOL, usd6(usd));
  }
  /** Interest accrues on what's owed. */
  accrue(a: Address, usd: number) {
    this.add(this.owed, a, usd6(usd));
  }
  /** A liquidator repays `debtUsd` and takes collateral worth `debtUsd × (1 + bonus)` at Aave's price. */
  liquidate(a: Address, debtUsd: number, bonus: number) {
    const tx = this.tx();
    const seized = (usd6(debtUsd * (1 + bonus)) * 10n ** 10n) / this.price;
    this.add(this.owed, a, -usd6(debtUsd));
    this.add(this.stock, a, -seized);
    this.records.push({ kind: "spoke", ...this.base(tx), event: "LiquidationCall", reserveId: USDC.reserveId, caller: OUTSIDE, user: a, amount: usd6(debtUsd) });
  }

  /** What the board computes for `a`, given what `a` held at joining. */
  flows(a: Address, atJoin: { worth: number; owed: bigint }): Flows {
    const { moves, credit } = memberFlows(a, JOIN, this.records, rules);
    const value = (m: Move) => ("usd6" in m ? m.usd6 : stockUsd6(m.stock.raw, this.priceAt(m.block)));
    const sum = (dir: "in" | "out") => Number(moves.filter((m) => m.dir === dir).reduce((s, m) => s + value(m), 0n)) / 1e6;
    return {
      worthAtJoin: atJoin.worth,
      worthNow: this.worth(a),
      putIn: sum("in"),
      takenOut: sum("out"),
      peakCredit: Number(peakCredit(atJoin.owed, credit, this.get(this.owed, a))) / 1e6,
    };
  }
  /** Holdings at the end of the join block: what a member starts from. */
  snapshot(a: Address) {
    return { worth: this.worth(a), owed: this.get(this.owed, a) };
  }
}

const pct = (f: Flows) => returnSinceJoining(f).pct!;

describe("returnSinceJoining", () => {
  it("is the gain over own money: +10% on a stock that rose 10%", () => {
    const l = new Ledger();
    l.deposit(SAM, 1_000); // before joining: part of what Sam starts from
    const start = l.snapshot(SAM);
    l.next().buy(SAM, 1_000);
    l.next(priceRaw(110));
    expect(pct(l.flows(SAM, start))).toBeCloseTo(0.1, 6);
  });

  it("a deposit or withdrawal after joining doesn't move the gain (the percent is then over the new own money)", () => {
    const l = new Ledger();
    l.deposit(SAM, 1_000);
    const start = l.snapshot(SAM);
    l.next().buy(SAM, 1_000);
    l.next(priceRaw(110));
    const before = pct(l.flows(SAM, start));
    l.next().deposit(SAM, 5_000);
    // The new money sits in cash: the dollar gain is the same; the percent is over more own money.
    expect(returnSinceJoining(l.flows(SAM, start)).gain).toBeCloseTo(100, 6);
    l.next().withdraw(SAM, 5_000);
    expect(returnSinceJoining(l.flows(SAM, start)).gain).toBeCloseTo(100, 6);
    expect(pct(l.flows(SAM, start))).toBeLessThanOrEqual(before);
    expect(pct(l.flows(SAM, start))).toBeGreaterThan(0);
  });

  it("a deposit alone is never a gain", () => {
    const l = new Ledger();
    l.deposit(SAM, 50);
    const start = l.snapshot(SAM);
    l.next().deposit(SAM, 10_000);
    l.next().deposit(SAM, 7_000, KIT);
    expect(pct(l.flows(SAM, start))).toBe(0);
  });

  it("a Credit Buy never lifts it, whatever the stock does", () => {
    for (const move of [0.3, 0.1, 0.01, 0, -0.01, -0.1, -0.3]) {
      const cash = new Ledger();
      const credit = new Ledger();
      for (const l of [cash, credit]) l.deposit(SAM, 1_000);
      const [a, b] = [cash.snapshot(SAM), credit.snapshot(SAM)];
      cash.next().buy(SAM, 1_000);
      credit.next().buy(SAM, 1_000);
      credit.creditBuy(SAM, 500);
      const p = priceRaw(100 * (1 + move));
      cash.next(p);
      credit.next(p);
      const withCredit = pct(credit.flows(SAM, b));
      const without = pct(cash.flows(SAM, a));
      expect(withCredit).toBeLessThanOrEqual(without + 1e-12);
      if (move > 0) expect(withCredit).toBeCloseTo(without, 6); // the same +10% before interest, not +15%
    }
  });

  it("credit left as cash can't cushion a loss", () => {
    const l = new Ledger();
    l.deposit(SAM, 1_000);
    const start = l.snapshot(SAM);
    l.next().buy(SAM, 1_000);
    l.next(priceRaw(90));
    const loss = pct(l.flows(SAM, start));
    // Draw $9,000 of credit and keep it as cash: net worth is unchanged, the most credit in use is $9,000.
    l.records.push({ kind: "spoke", block: l.block, tx: `0x${"ab".repeat(32)}`, logIndex: 999, event: "Borrow", reserveId: USDC.reserveId, caller: SAM, user: SAM, amount: usd6(9_000) });
    expect(pct(l.flows(SAM, start))).toBeCloseTo(loss, 9);
    expect(loss).toBeCloseTo(-0.1, 6);
  });

  it("interest lowers it", () => {
    const l = new Ledger();
    l.deposit(SAM, 1_000);
    const start = l.snapshot(SAM);
    l.next().buy(SAM, 1_000);
    l.creditBuy(SAM, 500);
    l.next(priceRaw(110));
    const before = pct(l.flows(SAM, start));
    l.accrue(SAM, 12);
    expect(pct(l.flows(SAM, start))).toBeLessThan(before);
  });

  it("the network fee lowers it, and isn't money taken out", () => {
    const l = new Ledger();
    l.deposit(SAM, 1_000);
    const start = l.snapshot(SAM);
    l.next().buy(SAM, 500, 0.05);
    const f = l.flows(SAM, start);
    expect(f.takenOut).toBe(0);
    expect(returnSinceJoining(f).gain).toBeCloseTo(-0.05, 6);
    expect(pct(f)).toBeLessThan(0);
  });

  it("a liquidation lowers it by its penalty", () => {
    const l = new Ledger();
    l.deposit(SAM, 1_000);
    const start = l.snapshot(SAM);
    l.next().buy(SAM, 1_000);
    l.creditBuy(SAM, 700);
    l.next(priceRaw(80));
    const before = returnSinceJoining(l.flows(SAM, start));
    l.next().liquidate(SAM, 350, 0.055);
    const after = returnSinceJoining(l.flows(SAM, start));
    expect(after.gain).toBeCloseTo(before.gain - 350 * 0.055, 4);
    expect(after.pct!).toBeLessThan(before.pct!);
    // The credit cleared doesn't change the most credit in use.
    expect(l.flows(SAM, start).peakCredit).toBeCloseTo(700, 6);
  });

  it("transfers between two members net to zero", () => {
    const l = new Ledger();
    l.deposit(SAM, 1_000);
    l.deposit(KIT, 1_000);
    const [s, k] = [l.snapshot(SAM), l.snapshot(KIT)];
    l.next().buy(SAM, 1_000);
    l.buy(KIT, 500);
    l.next(priceRaw(120));
    const [sBefore, kBefore] = [returnSinceJoining(l.flows(SAM, s)), returnSinceJoining(l.flows(KIT, k))];
    l.next().pay(KIT, SAM, 300);
    l.next().pay(SAM, KIT, 50);
    const [sAfter, kAfter] = [returnSinceJoining(l.flows(SAM, s)), returnSinceJoining(l.flows(KIT, k))];
    expect(sAfter.gain).toBeCloseTo(sBefore.gain, 6);
    expect(kAfter.gain).toBeCloseTo(kBefore.gain, 6);
    expect(sAfter.gain + kAfter.gain).toBeCloseTo(sBefore.gain + kBefore.gain, 6);
  });

  it(`isn't ranked under $${MIN_PUT_IN_USD} of own money`, () => {
    expect(returnSinceJoining({ worthAtJoin: 5, worthNow: 6, putIn: 14.99, takenOut: 0, peakCredit: 0 }).pct).toBeNull();
    expect(returnSinceJoining({ worthAtJoin: 5, worthNow: 25, putIn: 15, takenOut: 0, peakCredit: 0 }).pct).toBeCloseTo(0.25, 9);
    expect(returnSinceJoining({ worthAtJoin: 0, worthNow: 0, putIn: 0, takenOut: 0, peakCredit: 0 }).pct).toBeNull();
  });
});

describe("rankRows", () => {
  const row = (account: string, joinedAt: bigint, p: number | null) => ({ account: account as Address, joinedAt, pct: p });

  it("ranks the highest return first, ties to whoever joined first, the unranked after with no rank", () => {
    const rows = rankRows([row("0xc", 3n, 0.05), row("0xa", 1n, null), row("0xb", 2n, 0.05), row("0xd", 4n, 0.2), row("0xe", 0n, null)]);
    expect(rows.map((r) => [r.account, r.rank])).toEqual([
      ["0xd", 1],
      ["0xb", 2],
      ["0xc", 3],
      ["0xe", null],
      ["0xa", null],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildBorrowCalls, type Call } from "@/lib/aave/tx";
import { nyDay } from "@/lib/agents/next";
import type { Cash } from "@/lib/cash";
import type { BackingOption, CreditPosition } from "@/lib/creditBuy";
import {
  EARN_CLOSED,
  EARN_COSTS_MORE,
  assertEarn,
  buildEarnCalls,
  earnActivity,
  earnBlock,
  earnHint,
  earnOffer,
  earnQuote,
  earnRates,
  earnRiskLine,
  earnSmallPrint,
  earnStop,
  marginalApy,
  minEarnUsd,
  pctText,
  saveRoomRaw,
  type EarnInput,
  type EarnOpen,
  type SaveRoomInput,
} from "@/lib/earnWithStocks";
import { buildBuyCalls } from "@/lib/swap/buy";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const other: Address = "0x00000000000000000000000000000000000000ee";
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const tsla = EQUITIES.find((e) => e.symbol === "TSLAc")!;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

/** Thursday 2026-10-15, 11:00 New York: markets open. */
const NOW = Date.UTC(2026, 9, 15, 15, 0) / 1000;
const option = (freeUsd: number, cf = 0.7): BackingOption => ({ stock: tsla, freeRaw: BigInt(Math.round((freeUsd / 378.38) * 1e8)), freeUsd, cf });
/** $900 of NVIDIA backs credit at 70%; nothing owed unless said. */
const position = (over: Partial<CreditPosition> = {}): CreditPosition => ({
  collateralUsd: 900,
  avgCf: 0.7,
  debtUsd: 0,
  healthFactor: null,
  usdcLiquidity: 2_770_000,
  borrowPaused: false,
  ...over,
});
const cash: Cash = { walletRaw: usdc(1), savingsRaw: usdc(2_399), saveOn: true };
const room = (over: Partial<SaveRoomInput> = {}): SaveRoomInput => ({
  leftRaw: usdc(1_000),
  walletRaw: usdc(1),
  keepBackRaw: usdc(1),
  minSaveRaw: usdc(1),
  savesDay: nyDay(NOW),
  savesToday: 1,
  maxSavesPerDay: 6,
  nowSec: NOW,
  ...over,
});
/** Today's live rates (2026-10-15): cash 4.13% APY, credit 2.14% APY. */
const input = (over: Partial<EarnInput> = {}): EarnInput => ({
  save: "on",
  cashApy: 0.0413,
  creditApy: 0.0214,
  position: position(),
  options: [option(1_400)],
  cash,
  room: room(),
  now: new Date(NOW * 1000),
  ...over,
});
const open = (o: ReturnType<typeof earnOffer>): EarnOpen => {
  if (o.kind !== "offer") throw new Error(`not offered: ${JSON.stringify(o)}`);
  return o;
};

describe("earnOffer: whether the Cash sheet offers it", () => {
  it("has no card without an executor, and a skeleton while anything loads", () => {
    expect(earnOffer(input({ save: "unconfigured" }))).toEqual({ kind: "hidden" });
    expect(earnOffer(input({ save: "loading" }))).toEqual({ kind: "loading" });
    expect(earnOffer(input({ options: undefined }))).toEqual({ kind: "loading" });
    expect(earnOffer(input({ room: null }))).toEqual({ kind: "loading" });
  });

  it("asks to start earning first: cash earns only through Save", () => {
    expect(earnOffer(input({ save: "off" }))).toMatchObject({ kind: "closed", why: "off", text: "Your cash isn’t earning yet. Start earning first." });
    expect(earnOffer(input({ save: "starting" }))).toMatchObject({ kind: "closed", why: "starting", text: EARN_CLOSED.starting });
    // Off doesn't wait on the rest.
    expect(earnOffer(input({ save: "off", options: undefined, room: null }))).toMatchObject({ kind: "closed", why: "off" });
  });

  it("needs stocks that can back credit", () => {
    expect(earnOffer(input({ options: [], position: position({ collateralUsd: 0 }) }))).toMatchObject({ why: "no-stocks" });
    // What already backs credit counts.
    expect(earnOffer(input({ options: [] })).kind).toBe("offer");
  });

  it("is offered at today's rates: 4.1% earned, 2.2% cost, about 1.9% left", () => {
    const o = open(earnOffer(input()));
    expect([pctText(o.rates.earn), pctText(o.rates.cost), pctText(o.rates.left)]).toEqual(["4.1%", "2.2%", "1.9%"]);
  });

  it("isn't offered when credit costs as much as the cash earns, or more, as shown", () => {
    const zero = earnOffer(input({ cashApy: 0.0413, creditApy: 0.0405 }));
    expect(zero).toMatchObject({ kind: "closed", why: "costs-more", text: "Credit costs more than your cash earns right now.", rates: { earn: 41, cost: 41, left: 0 } });
    expect(earnOffer(input({ creditApy: 0.05 }))).toMatchObject({ why: "costs-more", rates: { left: -9 } });
    // A true gap of 0.05 points rounds to 0.0 on screen (4.15% down to 4.1%, 4.10% up to 4.1%): not offered.
    expect(earnOffer(input({ cashApy: 0.0415, creditApy: 0.041 }))).toMatchObject({ why: "costs-more" });
    // A rate exactly on a tenth isn't rounded the wrong way.
    expect(earnRates(0.041, 0.022)).toEqual({ earn: 41, cost: 22, left: 19 });
  });

  it("isn't offered while new credit is paused, or with no cash for the network fee", () => {
    expect(earnOffer(input({ position: position({ borrowPaused: true }) }))).toMatchObject({ why: "paused", text: "New credit is paused right now. Try again later." });
    const poor: Cash = { walletRaw: usdc(0.2), savingsRaw: usdc(0.2), saveOn: true };
    expect(earnOffer(input({ cash: poor, room: room({ walletRaw: poor.walletRaw }) }))).toMatchObject({ why: "fee" });
  });
});

describe("earnOffer: caps", () => {
  it("is the least of what Save moves today, the credit the stocks back and the USDC available", () => {
    // Save's room binds: $1,000 left today.
    expect(open(earnOffer(input()))).toMatchObject({ maxUsd: 1_000, limitedBy: "today" });
    // The credit binds: $100 of Tesla at 70%, nothing else, 99.5% of it as /use-credit.
    expect(open(earnOffer(input({ position: position({ collateralUsd: 0 }), options: [option(100)] })))).toMatchObject({ maxUsd: 69, limitedBy: "credit" });
    // The USDC available binds.
    expect(open(earnOffer(input({ position: position({ usdcLiquidity: 50 }) })))).toMatchObject({ maxUsd: 49, limitedBy: "credit" });
  });

  it("leaves room for wallet USDC that Save hasn't moved yet", () => {
    const r = room({ walletRaw: usdc(301) });
    expect(saveRoomRaw(r)).toBe(usdc(700));
    expect(open(earnOffer(input({ room: r })))).toMatchObject({ maxUsd: 700, limitedBy: "today" });
    // The keep-back stays in the wallet and isn't swept.
    expect(saveRoomRaw(room({ walletRaw: usdc(1) }))).toBe(usdc(1_000));
  });

  it("has no room once today's saves are used up, and counts them again on a new New York day", () => {
    const full = room({ savesToday: 6 });
    expect(saveRoomRaw(full)).toBe(0n);
    expect(earnOffer(input({ room: full }))).toMatchObject({ why: "today", text: "Your cash can’t start earning on more today. Try again tomorrow." });
    expect(saveRoomRaw(room({ savesToday: 6, savesDay: nyDay(NOW) - 1 }))).toBe(usdc(1_000));
  });

  it("stays within the test deploy's $5 cap", () => {
    const o = open(earnOffer(input({ room: room({ leftRaw: usdc(5) }) })));
    expect(o.maxUsd).toBeLessThanOrEqual(5);
    expect(o).toMatchObject({ maxUsd: 5, limitedBy: "today" });
    expect(earnHint(o)).toBe("Up to $5 today, so all of it starts earning.");
  });

  it("says when the stocks can't back more", () => {
    expect(earnOffer(input({ position: position({ collateralUsd: 0 }), options: [option(1)] }))).toMatchObject({
      why: "credit",
      text: "Your stocks can’t back more credit right now.",
    });
  });

  it("starts at $1, or at Save's smallest save less what already waits", () => {
    expect(minEarnUsd(room())).toBe(1);
    expect(minEarnUsd(room({ minSaveRaw: usdc(10) }))).toBe(10);
    expect(minEarnUsd(room({ minSaveRaw: usdc(10), walletRaw: usdc(5) }))).toBe(6);
  });

  it("says the Safe line under the credit cap when it's lower", () => {
    const o = open(earnOffer(input({ room: room({ leftRaw: usdc(5_000) }) })));
    expect(o.limitedBy).toBe("credit");
    expect(earnHint(o)).toBe(`Up to $${o.maxUsd.toLocaleString("en-US")}. Stay under $${Math.floor(o.maxSafeUsd).toLocaleString("en-US")} to stay Safe.`);
  });
});

describe("earnQuote: one amount", () => {
  const owing = position({ debtUsd: 300, healthFactor: 2.1 });
  const quote = (amount: number, p: { pos?: CreditPosition; after?: number | null; offer?: EarnOpen } = {}) => {
    const pos = p.pos ?? owing;
    const offer = p.offer ?? open(earnOffer(input({ position: pos })));
    return {
      offer,
      q: earnQuote({ offer, position: pos, options: [option(1_400)], cash, creditRaw: usdc(amount), creditApyNow: 0.0214, creditApyAfter: p.after === undefined ? 0.0214 : p.after, now: new Date(NOW * 1000) }),
    };
  };

  it("stops over the cap and under the smallest amount", () => {
    const over = quote(1_001);
    expect(earnBlock(over.q, over.offer)).toBe("Up to $1,000 today, so all of it starts earning.");
    const under = quote(0.5);
    expect(earnBlock(under.q, under.offer)).toBe("The smallest amount is $1.");
    const ok = quote(500);
    expect(earnBlock(ok.q, ok.offer)).toBeNull();
    expect(ok.q).toMatchObject({ cost: 22, left: 19, leftUsdYear: 9 });
  });

  it("charges this credit what it adds to the whole debt's cost: a premium rise lowers what's left", () => {
    expect(marginalApy({ debtUsd: 1_000, amountUsd: 100, apyNow: 0.0214, apyAfter: 0.023 })).toBeCloseTo(0.039, 6);
    const big = position({ debtUsd: 1_000, collateralUsd: 5_000, healthFactor: 3.5 });
    const rise = quote(100, { pos: big, after: 0.023 });
    expect(rise.q).toMatchObject({ cost: 39, left: 2 });
    const steep = quote(100, { pos: big, after: 0.0235 });
    expect(steep.q.left).toBeLessThan(0);
    expect(earnBlock(steep.q, steep.offer)).toBe(EARN_COSTS_MORE);
    expect(EARN_COSTS_MORE).toBe("At this amount, credit costs more than your cash earns right now.");
  });

  it("waits for the rate after the batch before it can be signed", () => {
    const { q, offer } = quote(500, { after: null });
    expect(q.cost).toBeNull();
    expect(earnBlock(q, offer)).toBeNull();
    expect(earnStop(q, offer, false)).toBe("One moment…");
  });

  it("needs the risk tick when it ends in Watch or Act, and not in Safe", () => {
    const safe = quote(500);
    expect(safe.q.plan.after).toBe("safe");
    expect(earnStop(safe.q, safe.offer, false)).toBeNull();

    const watch = quote(1_000);
    expect(watch.q.plan.after).toBe("watch");
    expect(earnStop(watch.q, watch.offer, false)).toBe("Confirm you understand this puts your credit in Watch first.");
    expect(earnStop(watch.q, watch.offer, true)).toBeNull();

    const wide = open(earnOffer(input({ position: owing, room: room({ leftRaw: usdc(5_000) }) })));
    const act = quote(1_250, { offer: wide });
    expect(act.q.plan.after).toBe("act");
    expect(earnStop(act.q, act.offer, false)).toBe("Confirm you understand this puts your credit in Act first.");
    expect(earnStop(act.q, act.offer, true)).toBeNull();
  });

  it("puts what already backs credit first, then the free stock", () => {
    const { q } = quote(100);
    expect(q.plan.backing).toEqual([]);
    const more = quote(500);
    expect(more.q.plan.backing.map((b) => b.stock.symbol)).toEqual(["TSLAc"]);
    expect(earnActivity(more.q.plan)).toEqual([
      { kind: "supply", symbol: "TSLAc", amount: Number(more.q.plan.backing[0].raw) / 1e8 },
      { kind: "borrow", symbol: "USDC", amount: 500 },
    ]);
  });
});

describe("the words around the button", () => {
  it("says what Protect does if the stocks fall", () => {
    expect(earnRiskLine({ names: ["Tesla"], protect: "on", sell: "on" })).toBe(
      "If Tesla falls, you can repay from your cash, or Protect repays from it, then sells a little Tesla to keep you Safe.",
    );
    expect(earnRiskLine({ names: ["Tesla"], protect: "on", sell: "off" })).toBe(
      "If Tesla falls, you can repay from your cash, or Protect repays from it. Protect won’t sell your stock.",
    );
    expect(earnRiskLine({ names: ["Tesla", "NVIDIA"], protect: "off", sell: "off" })).toBe(
      "If your stocks fall, repay from your cash. If they fall too far, part of them can be sold to repay what you owe. Protect is off.",
    );
    expect(earnRiskLine({ names: ["Tesla"], protect: "starting", sell: "off" })).not.toMatch(/Protect is off/);
  });

  it("lists every move in small print, with the tokenized-stock line", () => {
    const text = earnSmallPrint({ backing: [{ symbol: "TSLAc", shares: 0.43 }], amountUsd: 1_000, owedUsd: 1_063.2, backedBy: ["Tesla"], risk: "R." });
    expect(text).toBe(
      "In one go: 0.43 TSLA goes in use to back credit and $1,000 of credit comes to your cash, where it starts earning soon. You’ll owe $1,064, backed by Tesla. R. Tokenized stocks track the share price; they are not company shares or voting rights.",
    );
  });

  it("never says borrow, loan, leverage or lock", () => {
    const all = [
      ...Object.values(EARN_CLOSED),
      EARN_COSTS_MORE,
      earnRiskLine({ names: ["Tesla"], protect: "off", sell: "off" }),
      earnSmallPrint({ backing: [{ symbol: "TSLAc", shares: 1 }], amountUsd: 5, owedUsd: 5, backedBy: ["Tesla"], risk: "" }),
    ].join(" ");
    expect(all).not.toMatch(/borrow|loan|lend|leverage|lock|aave|savings|vault/i);
  });
});

describe("assertEarn: the batch is what the screen says", () => {
  const backing = [{ stock: tsla, raw: 50_000_000n }];
  const creditRaw = usdc(500);

  it("accepts the plan's batch: backing in use, then the credit, last", () => {
    const calls = buildEarnCalls({ user, backing, creditRaw });
    expect(calls).toHaveLength(4);
    expect(buildEarnCalls({ user, backing: [], creditRaw })).toHaveLength(1);
    expect(buildEarnCalls({ user, backing: [...backing, { stock: nvda, raw: 1_000n }], creditRaw })).toHaveLength(7);
  });

  it("rejects a second credit, a different amount, a swap, a transfer and someone else's position", () => {
    const calls = buildEarnCalls({ user, backing, creditRaw });
    expect(() => assertEarn(user, [...calls, ...buildBorrowCalls({ user, amountRaw: creditRaw })], { creditRaw, backing })).toThrow(/Blocked/);
    expect(() => assertEarn(user, calls, { creditRaw: usdc(501), backing })).toThrow(/credit differs/);
    const swap = buildBuyCalls({ user, stock: nvda, quote: { venue: "aerodrome", pool: 10, amountIn: creditRaw, amountOut: 1n } });
    expect(() => assertEarn(user, [...calls.slice(0, 3), ...swap], { creditRaw, backing })).toThrow(/Blocked/);
    const transfer: Call = { to: USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [other, creditRaw] }), value: 0n };
    expect(() => assertEarn(user, [...calls.slice(0, 3), transfer], { creditRaw, backing })).toThrow(/Blocked/);
    const theirs: Call = { to: AAVE.SPOKE, data: encodeFunctionData({ abi: spokeAbi, functionName: "borrow", args: [BigInt(USDC.reserveId), creditRaw, other] }), value: 0n };
    expect(() => assertEarn(user, [...calls.slice(0, 3), theirs], { creditRaw, backing })).toThrow(/credit differs/);
    // The backing must be the plan's, for the user.
    expect(() => assertEarn(user, calls, { creditRaw, backing: [{ stock: tsla, raw: 49_000_000n }] })).toThrow(/Blocked/);
    expect(() => assertEarn(other, calls, { creditRaw, backing })).toThrow(/Blocked/);
  });
});

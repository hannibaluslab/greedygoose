import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, erc20Abi } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { buildCreditCalls, type Call } from "@/lib/aave/tx";
import { feeBufferRaw, type Cash } from "@/lib/cash";
import type { BackingOption, CreditPosition } from "@/lib/creditBuy";
import {
  EARN_CLOSED,
  EARN_COSTS_MORE,
  assertEarn,
  buildEarnCalls,
  earnActivity,
  earnBlock,
  earnDone,
  earnHint,
  earnOffer,
  earnQuote,
  earnRates,
  earnRiskLine,
  earnSmallPrint,
  earnStop,
  marginalApy,
  pctText,
  type EarnInput,
  type EarnOpen,
} from "@/lib/earnWithStocks";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { buildAddSavingsCalls, buildWithdrawSavingsCalls } from "@/lib/savings";
import { buildBuyCalls } from "@/lib/swap/buy";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const other: Address = "0x00000000000000000000000000000000000000ee";
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
/** Cash split between the wallet and savings, a unit short of the network-fee buffer in all. */
const underFee: Cash = { walletRaw: feeBufferRaw / 2n, savingsRaw: feeBufferRaw / 2n - 1n, saveOn: false };
const tsla = EQUITIES.find((e) => e.symbol === "TSLAc")!;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

/** Thursday 2026-10-15, 11:00 New York: markets open. */
const NOW = Date.UTC(2026, 9, 15, 15, 0) / 1000;
const option = (freeUsd: number, cf = 0.7): BackingOption => ({
  stock: tsla,
  freeRaw: BigInt(Math.round((freeUsd / 378.38) * 1e8)),
  freeUsd,
  cf,
});
/** $900 of NVIDIA backs credit at 70%; nothing owed unless said. */
const position = (over: Partial<CreditPosition> = {}): CreditPosition => ({
  totalBackingUsd: 900,
  avgCf: 0.7,
  debtUsd: 0,
  healthFactor: null,
  usdcLiquidity: 2_770_000,
  creditPaused: false,
  ...over,
});
const cash: Cash = { walletRaw: usdc(1), savingsRaw: usdc(2_399), saveOn: true };
/** The public link: no agent, so nothing earns yet and all the cash is in the wallet. */
const noAgent: Cash = { walletRaw: usdc(40), savingsRaw: 0n, saveOn: false };
/** Today's live rates (2026-10-15): cash 4.13% APY, credit 2.14% APY. */
const input = (over: Partial<EarnInput> = {}): EarnInput => ({
  cashApy: 0.0413,
  creditApy: 0.0214,
  position: position(),
  options: [option(1_400)],
  cash,
  now: new Date(NOW * 1000),
  ...over,
});
const open = (o: ReturnType<typeof earnOffer>): EarnOpen => {
  if (o.kind !== "offer") throw new Error(`not offered: ${JSON.stringify(o)}`);
  return o;
};

describe("earnOffer: whether the Cash sheet offers it", () => {
  it("shows a skeleton while the stocks' backing loads, and one line once that read failed", () => {
    expect(earnOffer(input({ options: undefined }))).toEqual({ kind: "loading" });
    expect(earnOffer(input({ options: undefined, unread: true }))).toMatchObject({
      kind: "closed",
      why: "unread",
      text: "We couldn’t check this right now. Try again in a moment.",
    });
    // Once it's read, a failed refresh doesn't take the offer away.
    expect(earnOffer(input({ unread: true }))).toMatchObject({ kind: "offer" });
  });

  it("needs no agent: offered with earning off, as on the public link", () => {
    const o = open(earnOffer(input({ cash: noAgent })));
    expect(o).toMatchObject({ kind: "offer", minUsd: 0.01 });
    // The same offer whether the Save job runs or not: nothing in it waits for an agent.
    expect(earnOffer(input({ cash: { ...noAgent, saveOn: true } }))).toEqual(o);
    // The old closed states are gone.
    expect(Object.keys(EARN_CLOSED)).toEqual([
      "no-stocks",
      "costs-more",
      "paused",
      "credit",
      "in-act",
      "fee",
      "unread",
    ]);
  });

  it("needs stocks that can back credit", () => {
    expect(earnOffer(input({ options: [], position: position({ totalBackingUsd: 0 }) }))).toMatchObject({
      why: "no-stocks",
    });
    // What already backs credit counts.
    expect(earnOffer(input({ options: [] })).kind).toBe("offer");
  });

  it("is offered at today's rates: 4.1% earned, 2.2% cost, about 1.9% left", () => {
    const o = open(earnOffer(input()));
    expect([pctText(o.rates.earn), pctText(o.rates.cost), pctText(o.rates.left)]).toEqual(["4.1%", "2.2%", "1.9%"]);
  });

  it("isn't offered when credit costs as much as the cash earns, or more, as shown", () => {
    const zero = earnOffer(input({ cashApy: 0.0413, creditApy: 0.0405 }));
    expect(zero).toMatchObject({
      kind: "closed",
      why: "costs-more",
      text: "Credit costs more than your cash earns right now.",
      rates: { earn: 41, cost: 41, left: 0 },
    });
    expect(earnOffer(input({ creditApy: 0.05 }))).toMatchObject({ why: "costs-more", rates: { left: -9 } });
    // A true gap of 0.05 points rounds to 0.0 on screen (4.15% down to 4.1%, 4.10% up to 4.1%): not offered.
    expect(earnOffer(input({ cashApy: 0.0415, creditApy: 0.041 }))).toMatchObject({ why: "costs-more" });
    // A rate exactly on a tenth isn't rounded the wrong way.
    expect(earnRates(0.041, 0.022)).toEqual({ earn: 41, cost: 22, left: 19 });
  });

  it("isn't offered while new credit is paused, or with no cash for the network fee", () => {
    expect(earnOffer(input({ position: position({ creditPaused: true }) }))).toMatchObject({
      why: "paused",
      text: "New credit is paused right now. Try again later.",
    });
    expect(earnOffer(input({ cash: underFee }))).toMatchObject({ why: "fee" });
    // The fee can come from savings: wallet empty, savings enough.
    expect(earnOffer(input({ cash: { walletRaw: 0n, savingsRaw: feeBufferRaw, saveOn: true } })).kind).toBe("offer");
  });
});

describe("earnOffer: the cap", () => {
  it("is the least of the credit the stocks back (creditCap, Act is the line, as every way of taking credit) and the USDC available", () => {
    // $900 of NVIDIA and $1,400 of Tesla at 70%, nothing owed: no daily cap any more. At the cap's line:
    // 1,610 ÷ 1.12 = $1,437.50, rounded down to $1,437.
    const o = open(earnOffer(input()));
    expect(o.maxUsd).toBeGreaterThan(1_000);
    expect(o.maxUsd).toBe(1_437);
    // $100 of Tesla at 70%, nothing else: 70 ÷ 1.12 = $62.50.
    expect(
      open(earnOffer(input({ position: position({ totalBackingUsd: 0 }), options: [option(100)] }))),
    ).toMatchObject({
      maxUsd: 62,
    });
    // The USDC available binds.
    expect(open(earnOffer(input({ position: position({ usdcLiquidity: 50 }) })))).toMatchObject({ maxUsd: 50 });
  });

  it("isn't offered while the credit is in Act (Act is the line), whatever is free", () => {
    const inAct = position({ debtUsd: 600, healthFactor: 630 / 600 });
    expect(earnOffer(input({ position: inAct }))).toMatchObject({
      kind: "closed",
      why: "in-act",
      text: "Your credit is in Act. Repay some to use more.",
    });
    // At the cap's line it's Watch, not Act: offered, with what's left on the free Tesla (980 ÷ 1.12 = $875).
    const atCap = position({ debtUsd: 562.5, healthFactor: 630 / 562.5 });
    expect(open(earnOffer(input({ position: atCap })))).toMatchObject({ maxUsd: 875 });
  });

  it("says when the stocks can't back the smallest amount", () => {
    expect(earnOffer(input({ position: position({ totalBackingUsd: 0 }), options: [option(1)] }))).toMatchObject({
      why: "credit",
      text: "Your stocks can’t back more credit right now.",
    });
  });

  it("says the cap, and the Safe line when it's lower", () => {
    const o = open(earnOffer(input()));
    expect(earnHint(o)).toBe(
      `Up to $${o.maxUsd.toLocaleString("en-US")}. Stay under $${Math.floor(o.maxSafeUsd).toLocaleString("en-US")} to stay Safe.`,
    );
    const small = open(earnOffer(input({ position: position({ usdcLiquidity: 50 }) })));
    expect(earnHint(small)).toBe("Up to $50.");
  });
});

describe("earnQuote: one amount", () => {
  const owing = position({ debtUsd: 300, healthFactor: 2.1 });
  const quote = (amount: number, p: { pos?: CreditPosition; after?: number | null; offer?: EarnOpen } = {}) => {
    const pos = p.pos ?? owing;
    const offer = p.offer ?? open(earnOffer(input({ position: pos })));
    return {
      offer,
      q: earnQuote({
        offer,
        position: pos,
        options: [option(1_400)],
        cash,
        creditRaw: usdc(amount),
        creditApyNow: 0.0214,
        creditApyAfter: p.after === undefined ? 0.0214 : p.after,
        now: new Date(NOW * 1000),
      }),
    };
  };

  it("stops over the cap and under the smallest amount", () => {
    const capped = open(
      earnOffer(input({ position: position({ debtUsd: 300, healthFactor: 2.1, usdcLiquidity: 600 }) })),
    );
    // The USDC available binds, to the dollar (the cap on the stocks is $1,137).
    expect(capped.maxUsd).toBe(600);
    const over = quote(capped.maxUsd + 1, { offer: capped });
    expect(earnBlock(over.q, over.offer)).toBe(`Up to $${capped.maxUsd}.`);
    const under = quote(0.005);
    expect(earnBlock(under.q, under.offer)).toBe("The smallest amount is $0.01.");
    const ok = quote(500);
    expect(earnBlock(ok.q, ok.offer)).toBeNull();
    expect(ok.q).toMatchObject({ cost: 22, left: 19, leftUsdYear: 9 });
  });

  it("charges this credit what it adds to the whole debt's cost: a premium rise lowers what's left", () => {
    expect(marginalApy({ debtUsd: 1_000, amountUsd: 100, apyNow: 0.0214, apyAfter: 0.023 })).toBeCloseTo(0.039, 6);
    // A premium drop on the existing debt isn't counted as this credit being cheaper: never under its own rate.
    expect(marginalApy({ debtUsd: 1_000, amountUsd: 100, apyNow: 0.025, apyAfter: 0.02 })).toBe(0.02);
    const big = position({ debtUsd: 1_000, totalBackingUsd: 5_000, healthFactor: 3.5 });
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

  it("needs the risk tick when it ends in Watch, not in Safe; ending in Act is blocked, ticked or not", () => {
    const safe = quote(500);
    expect(safe.q.plan.after).toBe("safe");
    expect(earnStop(safe.q, safe.offer, false)).toBeNull();

    const watch = quote(1_000);
    expect(watch.q.plan.after).toBe("watch");
    expect(earnStop(watch.q, watch.offer, false)).toBe("Confirm you understand this puts your credit in Watch first.");
    expect(earnStop(watch.q, watch.offer, true)).toBeNull();

    // The cap: (630 + 980) ÷ 1.12 − 300 = $1,137.50, rounded down to $1,137, ends in Watch.
    expect(watch.offer.maxUsd).toBe(1_137);
    const top = quote(1_137);
    expect(top.q.plan).toMatchObject({ after: "watch", extraConfirm: true, block: undefined });
    expect(earnStop(top.q, top.offer, true)).toBeNull();
    const act = quote(1_250);
    expect(act.q.plan.after).toBe("act");
    expect(act.q.plan.extraConfirm).toBe(false);
    expect(earnStop(act.q, act.offer, false)).toBe("That would put your credit in Act. Try a smaller amount.");
    expect(earnStop(act.q, act.offer, true)).toBe("That would put your credit in Act. Try a smaller amount.");
  });

  it("puts what already backs credit first, then the free stock", () => {
    const { q } = quote(100);
    expect(q.plan.backing).toEqual([]);
    const more = quote(500);
    expect(more.q.plan.backing.map((b) => b.stock.symbol)).toEqual(["TSLAc"]);
    expect(earnActivity(more.q.plan)).toEqual([
      { kind: "earn", symbol: "USDC", amount: 500 },
      { kind: "supply", symbol: "TSLAc", amount: Number(more.q.plan.backing[0].raw) / 1e8 },
    ]);
  });
});

describe("the words around the button", () => {
  it("says what Protect does if the stocks fall: only at Act, back to Watch", () => {
    expect(earnRiskLine({ names: ["Tesla"], protect: "on", sell: "on" })).toBe(
      "If Tesla falls, you can repay from your cash. If your credit reaches Act, Protect repays from it, then sells a little Tesla to bring it back to Watch.",
    );
    expect(earnRiskLine({ names: ["Tesla"], protect: "on", sell: "off" })).toBe(
      "If Tesla falls, you can repay from your cash. If your credit reaches Act, Protect repays from it. Protect won’t sell your stock.",
    );
    expect(earnRiskLine({ names: ["Tesla", "NVIDIA"], protect: "off", sell: "off" })).toBe(
      "If your stocks fall, repay from your cash. If they fall too far, part of them can be sold to repay what you owe. Protect is off.",
    );
    expect(earnRiskLine({ names: ["Tesla"], protect: "starting", sell: "off" })).not.toMatch(/Protect is off/);
  });

  it("lists every move in small print; what a stock is stays on the stock sheet (ruling 35)", () => {
    const text = earnSmallPrint({
      backing: [{ symbol: "TSLAc", shares: 0.43 }],
      amountUsd: 1_000,
      owedUsd: 1_063.2,
      backedBy: ["Tesla"],
      risk: "R.",
    });
    expect(text).toBe(
      "In one go: 0.43 TSLA goes in use to back credit and $1,000 of credit comes to your cash and starts earning. You’ll owe $1,064, backed by Tesla. R.",
    );
    expect(earnDone(500)).toBe("$500 is in your cash, earning.");
  });

  it("never says borrow, loan, leverage or lock", () => {
    const all = [
      ...Object.values(EARN_CLOSED),
      earnDone(5),
      EARN_COSTS_MORE,
      earnRiskLine({ names: ["Tesla"], protect: "off", sell: "off" }),
      earnSmallPrint({
        backing: [{ symbol: "TSLAc", shares: 1 }],
        amountUsd: 5,
        owedUsd: 5,
        backedBy: ["Tesla"],
        risk: "",
      }),
    ].join(" ");
    expect(all).not.toMatch(/creditCall|loan|lend|leverage|lock|aave|savings|vault/i);
  });
});

const v3 = (c: Call) => decodeFunctionData({ abi: aaveV3PoolAbi, data: c.data });
const erc20 = (c: Call) => decodeFunctionData({ abi: erc20Abi, data: c.data });
const spoke = (c: Call) => decodeFunctionData({ abi: spokeAbi, data: c.data });

describe("buildEarnCalls: one batch, stocks in use → credit → into savings", () => {
  const backing = [{ stock: tsla, raw: 50_000_000n }];
  const creditRaw = usdc(500);

  it("puts the stock in use, takes the credit, then approves and supplies exactly that credit for the user", () => {
    const calls = buildEarnCalls({ user, backing, creditRaw, cash: noAgent });
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.value === 0n)).toBe(true);
    const [approveStock, supply, use, creditCall, approveSave, save] = calls;
    expect(approveStock.to).toBe(tsla.address);
    expect(erc20(approveStock)).toMatchObject({ functionName: "approve", args: [AAVE.SPOKE, 50_000_000n] });
    expect(spoke(supply)).toMatchObject({ functionName: "supply", args: [BigInt(tsla.reserveId), 50_000_000n, user] });
    expect(spoke(use)).toMatchObject({
      functionName: "setUsingAsCollateral",
      args: [BigInt(tsla.reserveId), true, user],
    });
    expect(spoke(creditCall)).toMatchObject({
      functionName: "borrow",
      args: [BigInt(USDC.reserveId), creditRaw, user],
    });
    expect(approveSave.to).toBe(USDC.address);
    expect(erc20(approveSave)).toMatchObject({ functionName: "approve", args: [PROTOCOLS.AAVE_V3_POOL, creditRaw] });
    expect(save.to).toBe(PROTOCOLS.AAVE_V3_POOL);
    expect(v3(save)).toMatchObject({ functionName: "supply", args: [USDC.address, creditRaw, user, 0] });
  });

  it("with what already backs credit, it's the credit and the savings only; with two stocks, both first", () => {
    expect(buildEarnCalls({ user, backing: [], creditRaw, cash: noAgent }).map((c) => c.to)).toEqual([
      AAVE.SPOKE,
      USDC.address,
      PROTOCOLS.AAVE_V3_POOL,
    ]);
    expect(
      buildEarnCalls({ user, backing: [...backing, { stock: nvda, raw: 1_000n }], creditRaw, cash: noAgent }),
    ).toHaveLength(9);
  });

  it("pays the network fee from savings first when the wallet can't, and supplies the credit in full", () => {
    // Save on, less than the fee buffer in the wallet: the rest of the buffer comes out of savings so it stays for the fee.
    const thin: Cash = { walletRaw: (feeBufferRaw * 2n) / 5n, savingsRaw: usdc(100), saveOn: true };
    const calls = buildEarnCalls({ user, backing, creditRaw, cash: thin });
    expect(calls).toHaveLength(7);
    expect(calls[0].to).toBe(PROTOCOLS.AAVE_V3_POOL);
    expect(v3(calls[0])).toMatchObject({
      functionName: "withdraw",
      args: [USDC.address, feeBufferRaw - thin.walletRaw, user],
    });
    expect(v3(calls.at(-1)!)).toMatchObject({ functionName: "supply", args: [USDC.address, creditRaw, user, 0] });
    // Enough in the wallet: nothing comes out of savings.
    expect(buildEarnCalls({ user, backing, creditRaw, cash })[0].to).toBe(tsla.address);
    // Not even the fee: refused.
    expect(() => buildEarnCalls({ user, backing, creditRaw, cash: underFee })).toThrow(/More than your cash/);
  });
});

describe("assertEarn: the batch is what the screen says", () => {
  const backing = [{ stock: tsla, raw: 50_000_000n }];
  const creditRaw = usdc(500);
  const calls = buildEarnCalls({ user, backing, creditRaw, cash: noAgent });
  const review = { creditRaw, backing };
  const swapIn = (k: number, c: Call) => calls.map((x, i) => (i === k ? c : x));

  it("rejects a second credit, a different amount, a swap, a transfer and someone else's position", () => {
    expect(() => assertEarn(user, [...calls, ...buildCreditCalls({ user, amountRaw: creditRaw })], review)).toThrow(
      /Blocked/,
    );
    expect(() => assertEarn(user, calls, { creditRaw: usdc(501), backing })).toThrow(/credit differs/);
    const swap = buildBuyCalls({
      user,
      stock: nvda,
      quote: { venue: "aerodrome", pool: 10, amountIn: creditRaw, amountOut: 1n },
      oraclePriceUsd: 1_000_000,
    });
    expect(() => assertEarn(user, [...calls.slice(0, 4), ...swap], review)).toThrow(/Blocked/);
    const transfer: Call = {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [other, creditRaw] }),
      value: 0n,
    };
    expect(() => assertEarn(user, swapIn(5, transfer), review)).toThrow(/Blocked/);
    const theirs: Call = {
      to: AAVE.SPOKE,
      data: encodeFunctionData({
        abi: spokeAbi,
        functionName: "borrow",
        args: [BigInt(USDC.reserveId), creditRaw, other],
      }),
      value: 0n,
    };
    expect(() => assertEarn(user, swapIn(3, theirs), review)).toThrow(/credit differs/);
    // The backing must be the plan's, for the user.
    expect(() => assertEarn(user, calls, { creditRaw, backing: [{ stock: tsla, raw: 49_000_000n }] })).toThrow(
      /Blocked/,
    );
    expect(() => assertEarn(other, calls, review)).toThrow(/Blocked/);
  });

  it("rejects savings that aren't exactly the credit, for the user, in USDC, or a batch without them", () => {
    const [approveMore, saveMore] = buildAddSavingsCalls(user, creditRaw + 1n);
    expect(() => assertEarn(user, swapIn(4, approveMore), review)).toThrow(/approval differs/);
    expect(() => assertEarn(user, swapIn(5, saveMore), review)).toThrow(/differs from the credit/);
    const forOther = buildAddSavingsCalls(other, creditRaw)[1];
    expect(() => assertEarn(user, swapIn(5, forOther), review)).toThrow(/differs from the credit/);
    const tslaIn: Call = {
      to: PROTOCOLS.AAVE_V3_POOL,
      data: encodeFunctionData({
        abi: aaveV3PoolAbi,
        functionName: "supply",
        args: [tsla.address, creditRaw, user, 0],
      }),
      value: 0n,
    };
    expect(() => assertEarn(user, swapIn(5, tslaIn), review)).toThrow(/differs from the credit/);
    const referral: Call = {
      to: PROTOCOLS.AAVE_V3_POOL,
      data: encodeFunctionData({
        abi: aaveV3PoolAbi,
        functionName: "supply",
        args: [USDC.address, creditRaw, user, 7],
      }),
      value: 0n,
    };
    expect(() => assertEarn(user, swapIn(5, referral), review)).toThrow(/differs from the credit/);
    // Credit that stays in the wallet (the old batch) isn't this batch.
    expect(() => assertEarn(user, calls.slice(0, 4), review)).toThrow(/Blocked/);
    // A savings withdrawal goes only first, and only to the user.
    const [away] = buildWithdrawSavingsCalls(other, usdc(1), false);
    expect(() => assertEarn(user, [away, ...calls], review)).toThrow(/unexpected savings withdrawal/);
    const [mine] = buildWithdrawSavingsCalls(user, usdc(1), false);
    expect(assertEarn(user, [mine, ...calls], review)).toHaveLength(7);
    expect(() => assertEarn(user, [...calls.slice(0, 4), mine, ...calls.slice(4)], review)).toThrow(/Blocked/);
  });
});

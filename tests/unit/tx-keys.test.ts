import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { cashBuyPlan } from "@/hooks/useBuy";
import { contactsPlan } from "@/hooks/useContacts";
import { convertPlan, type ConvertQuote } from "@/hooks/useConvert";
import { creditBuyPlan } from "@/hooks/useCreditBuy";
import { earnPlan, type EarnInput } from "@/hooks/useEarnWithStocks";
import { repayPlan, type RepayInput } from "@/hooks/useRepay";
import { sendPlan, type SendInput } from "@/hooks/useSend";
import { setMixPlan } from "@/hooks/useManageSave";
import { keepMixPlan } from "@/hooks/useProtectSave";
import { salePlan, type SellInput } from "@/hooks/useSell";
import { swapPlan, type SwapReads } from "@/hooks/useTrade";
import type { CreditPlan } from "@/lib/creditBuy";
import type { SellPlan } from "@/lib/sell";
import type { BuyQuote } from "@/lib/swap/buy";
import { loanPlan, withdrawPlan } from "@/lib/tx/plans";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/*
 * Each write's key (lib/tx/prepared.ts): a batch prepared for one key is never signed for another, so the key must
 * change with every input that shapes the batch, and only with those (or the button would keep re-checking).
 */

const SAM = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427" as Address;
const ANN = "0x00000000000000000000000000000000000000aa" as Address;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const quote: BuyQuote = { venue: "aerodrome", pool: 10, amountIn: 20_000_000n, amountOut: 10_000_000n };
const noBatch = vi.fn(async () => []);

describe("a cash buy's key", () => {
  const key = (p: Partial<Parameters<typeof cashBuyPlan>[0]> = {}) => cashBuyPlan({ user: SAM, stock: nvda, quote, ...p }, noBatch).key;

  it("is the same for the same account, stock and quote", () => {
    expect(key()).toBe(key({ quote: { ...quote } }));
  });

  it("changes with the account, the stock, the amount, the quote's output and its pool", () => {
    const base = key();
    for (const other of [
      key({ user: ANN }),
      key({ stock: aapl }),
      key({ quote: { ...quote, amountIn: 21_000_000n } }),
      key({ quote: { ...quote, amountOut: 10_000_001n } }),
      key({ quote: { ...quote, pool: 100 } }),
      key({ quote: { ...quote, venue: "uniswap" } }),
    ])
      expect(other).not.toBe(base);
  });

  it("builds from the input it was keyed by", async () => {
    const batch = vi.fn(async () => []);
    const plan = cashBuyPlan({ user: SAM, stock: nvda, quote }, batch);
    await (plan.calls as () => Promise<unknown>)();
    expect(batch).toHaveBeenCalledWith({ user: SAM, stock: nvda, quote });
  });
});

describe("a Credit Buy's key", () => {
  const plan = {
    creditRaw: 15_000_000n,
    backing: [{ stock: aapl, raw: 5_000_000n, usd: 10 }],
    limit: { maxCreditRaw: 500_000_000n, freeRaw: { AAPLc: 5_000_000n } },
    before: "safe",
    after: "watch",
    hfAfter: 1.3,
    extraConfirm: true,
    maxSafeUsd: 100,
    maxUsd: 500,
    priceMayMove: false,
  } as CreditPlan;
  const key = (p: Partial<CreditPlan> = {}, confirmedRisk = true) =>
    creditBuyPlan({ user: SAM, stock: nvda, quote, plan: { ...plan, ...p }, confirmedRisk }, noBatch).key;

  it("changes with the credit, what goes in use, the stop and the risk tick", () => {
    const base = key();
    for (const other of [
      key({ creditRaw: 16_000_000n }),
      key({ backing: [{ stock: aapl, raw: 5_000_001n, usd: 10 }] }),
      key({ block: "paused" as CreditPlan["block"] }),
      key({ after: "act" }),
      key({}, false),
    ])
      expect(other).not.toBe(base);
  });

  it("not with what the screen only shows (the most it could use)", () => {
    expect(key({ maxUsd: 501, maxSafeUsd: 99 })).toBe(key());
  });
});

describe("a sale's key", () => {
  const plan = { from: "free", sharesRaw: quote.amountIn, minOutRaw: 9_900_000n } as SellPlan;
  const input: SellInput = { user: SAM, stock: nvda, quote, plan, oraclePriceUsd: 0.2, debtRaw: 64_000_000n };
  const key = (p: Partial<SellInput> = {}) => salePlan({ ...input, ...p }, noBatch).key;

  it("ignores what's owed (it accrues every block), except whether a repay by selling covers it", () => {
    expect(key({ debtRaw: 64_000_001n })).toBe(key());
    const repay = { ...plan, from: "repay" } as SellPlan;
    // The floor (about $9.90, less the fee) repays part of $64 owed: more interest doesn't change the batch.
    expect(key({ plan: repay, debtRaw: 64_000_001n })).toBe(key({ plan: repay }));
    // It covers $1 owed: still the same batch as interest accrues, but another one than repaying part.
    expect(key({ plan: repay, debtRaw: 1_000_001n })).toBe(key({ plan: repay, debtRaw: 1_000_000n }));
    expect(key({ plan: repay, debtRaw: 1_000_000n })).not.toBe(key({ plan: repay }));
  });

  it("changes with Aave's price only when it moves the sale's floor", () => {
    // The floor is the higher of the quote's and Aave's price's: a tiny price leaves the quote's floor.
    expect(key({ oraclePriceUsd: 0.21 })).toBe(key());
    expect(key({ oraclePriceUsd: 200 })).not.toBe(key());
  });

  it("changes with the quote and the screen's stop", () => {
    expect(key({ quote: { ...quote, amountOut: 10_000_001n } })).not.toBe(key());
    expect(key({ plan: { ...plan, block: "price" } as SellPlan })).not.toBe(key());
  });
});

describe("a stock → stock trade's key", () => {
  const reads = { quoteToSign: vi.fn(), cashToSign: vi.fn() } as unknown as SwapReads;
  const sell = { ...quote, amountIn: 5_000_000n, amountOut: 3_000_000n };
  const plan = { from: "free", sharesRaw: sell.amountIn } as SellPlan;
  const key = (feeFromSale = false, buy = quote) =>
    swapPlan({ route: "swap", user: SAM, from: nvda, to: aapl, sellQuote: sell, plan, buyQuote: buy, oraclePriceUsd: 0.2, feeFromSale }, reads).key;

  it("changes with who pays the fee and with the buy's quote", () => {
    expect(key(true)).not.toBe(key());
    expect(key(false, { ...quote, amountOut: 9n })).not.toBe(key());
    expect(key()).toBe(key());
  });
});

describe("Turn into cash's key", () => {
  const coin = ENTRY_COINS[0];
  const q = (p: Partial<ConvertQuote> = {}): ConvertQuote => ({ coin, amountIn: 120_000_000n, minOut: 119_400_000n, outRaw: 119_830_000n, fair: true, ...p });
  const plan = (quotes: ConvertQuote[]) => convertPlan(SAM, quotes, undefined, { invalidateQueries: vi.fn() } as never);

  it("is the coins, their amounts and floors: what a venue pays now only changes the words", () => {
    expect(plan([q({ outRaw: 119_900_000n })])!.key).toBe(plan([q()])!.key);
    expect(plan([q({ amountIn: 121_000_000n })])!.key).not.toBe(plan([q()])!.key);
  });

  it("leaves out a coin under its fair price, and has nothing to sign when none is fair", () => {
    expect(plan([q(), q({ coin: ENTRY_COINS[1], fair: false })])!.key).toBe(plan([q()])!.key);
    expect(plan([q({ fair: false })])).toBeNull();
  });
});

describe("the settings' and contacts' keys", () => {
  it("setMix by its weights, setKeepMix by its switch", () => {
    expect(setMixPlan(SAM, [5_000, 0, 0, 0, 0, 5_000, 0]).key).not.toBe(setMixPlan(SAM, [5_000, 0, 0, 0, 0, 4_900, 100]).key);
    expect(keepMixPlan(SAM, true).key).not.toBe(keepMixPlan(SAM, false).key);
  });

  it("contacts by the change and its people, in any order", () => {
    const k = (verb: "add" | "remove", targets: Address[]) => contactsPlan({ verb, user: SAM, targets }, undefined).key;
    expect(k("add", [ANN, SAM])).toBe(k("add", [SAM, ANN.toUpperCase().replace("0X", "0x") as Address]));
    expect(k("add", [ANN])).not.toBe(k("remove", [ANN]));
    expect(k("add", [ANN])).not.toBe(k("add", [ANN, SAM]));
  });
});

describe("a Send's key", () => {
  const BOB = "0x00000000000000000000000000000000000000bb" as Address;
  const input: SendInput = { user: SAM, token: USDC, recipient: { address: ANN, name: "ann.justan.id", onBase: true }, amountRaw: 25_000_000n };
  const key = (p: Partial<SendInput> = {}) => sendPlan({ ...input, ...p }, noBatch).key;

  it("changes when the recipient's address changes (a name that resolved late can't take its place)", () => {
    expect(key({ recipient: { ...input.recipient, address: BOB } })).not.toBe(key());
  });

  it("changes with the account, the token and the amount", () => {
    for (const other of [key({ user: BOB }), key({ token: nvda }), key({ amountRaw: 25_000_001n })]) expect(other).not.toBe(key());
  });

  it("is the address whatever its capitals, and not the name, which only labels Activity", () => {
    const upper = `0x${ANN.slice(2).toUpperCase()}` as Address;
    expect(key({ recipient: { ...input.recipient, address: upper } })).toBe(key());
    expect(key({ recipient: { ...input.recipient, name: null } })).toBe(key());
  });

  it("builds from the input it was keyed by", async () => {
    const batch = vi.fn(async () => []);
    await (sendPlan(input, batch).calls as () => Promise<unknown>)();
    expect(batch).toHaveBeenCalledWith(input);
  });
});

describe("Repay's key", () => {
  const input: RepayInput = { user: SAM, all: false, coversAll: false, amount: 100, amountRaw: 100_000_000n };
  const key = (p: Partial<RepayInput> = {}) => repayPlan({ ...input, ...p }, noBatch).key;

  it("a chip by its exact amount", () => {
    expect(key({ amountRaw: 300_000_000n, amount: 300 })).not.toBe(key());
  });

  it("All that covers what's owed: one batch whatever the interest added since", () => {
    const all = { all: true, coversAll: true };
    expect(key({ ...all, amount: 64.01, amountRaw: 64_010_000n })).toBe(key({ ...all, amount: 64.02, amountRaw: 64_020_000n }));
    expect(key(all)).not.toBe(key());
  });

  it("All the cash, short of what's owed: by the dollars on screen to the cent, so other cash is another batch", () => {
    const cash = { all: true, coversAll: false };
    expect(key({ ...cash, amount: 40.5, amountRaw: 40_500_000n })).not.toBe(key({ ...cash, amount: 41.5, amountRaw: 41_500_000n }));
    // Savings interest under a cent leaves it.
    expect(key({ ...cash, amount: 40.500001, amountRaw: 40_500_001n })).toBe(key({ ...cash, amount: 40.5, amountRaw: 40_500_000n }));
    expect(key({ ...cash, amount: 40.5 })).not.toBe(key({ all: true, coversAll: true, amount: 40.5 }));
  });

  it("builds from the input it was keyed by", async () => {
    const batch = vi.fn(async () => []);
    await (repayPlan(input, batch).calls as () => Promise<unknown>)();
    expect(batch).toHaveBeenCalledWith(input);
  });
});

describe("Use credit's and Free up's keys", () => {
  it("Use credit by the stocks put in, their amounts and the credit", () => {
    const k = (locks: { stock: typeof nvda; raw: bigint }[], borrowRaw: bigint) => loanPlan({ user: SAM, locks, borrowRaw }).key;
    const base = k([{ stock: nvda, raw: 5n }], 10_000_000n);
    expect(k([{ stock: nvda, raw: 5n }, { stock: aapl, raw: 0n }], 10_000_000n)).toBe(base);
    for (const other of [
      k([{ stock: nvda, raw: 6n }], 10_000_000n),
      k([{ stock: aapl, raw: 5n }], 10_000_000n),
      k([{ stock: nvda, raw: 5n }], 10_000_001n),
      loanPlan({ user: ANN, locks: [{ stock: nvda, raw: 5n }], borrowRaw: 10_000_000n }).key,
    ])
      expect(other).not.toBe(base);
  });

  it("Free up by the stock, the shares and All", () => {
    const k = (p: Partial<Parameters<typeof withdrawPlan>[0]> = {}) => withdrawPlan({ user: SAM, stock: nvda, amountRaw: 5n, all: false, ...p }).key;
    for (const other of [k({ stock: aapl }), k({ amountRaw: 6n }), k({ all: true }), k({ user: ANN })]) expect(other).not.toBe(k());
  });
});

describe("Earn with stocks' key", () => {
  const plan = {
    creditRaw: 100_000_000n,
    backing: [{ stock: aapl, raw: 5_000_000n, usd: 200 }],
    limit: { maxCreditRaw: 900_000_000n, freeRaw: { AAPLc: 5_000_000n } },
    before: "safe",
    after: "safe",
    hfAfter: 2,
    extraConfirm: false,
    maxSafeUsd: 500,
    maxUsd: 900,
    priceMayMove: false,
  } as CreditPlan;
  const quote = { plan, amountUsd: 100, cost: 50, left: 10, leftUsdYear: 1 } as EarnInput["quote"];
  const offer = { kind: "offer", minUsd: 1, maxUsd: 1_000, maxSafeUsd: 500, limitedBy: "credit" } as unknown as EarnInput["offer"];
  const key = (p: Partial<CreditPlan> = {}, confirmedRisk = false, q: Partial<EarnInput["quote"]> = {}) =>
    earnPlan({ user: SAM, quote: { ...quote, ...q, plan: { ...plan, ...p } }, offer, confirmedRisk }, vi.fn()).key;

  it("changes with the credit, what goes in use, where it ends, the risk tick and the stop", () => {
    for (const other of [
      key({ creditRaw: 100_000_001n }),
      key({ backing: [{ stock: nvda, raw: 5_000_000n, usd: 200 }] }),
      key({ after: "watch", extraConfirm: true }),
      key({}, true),
      key({}, false, { left: -1 }),
    ])
      expect(other).not.toBe(key());
  });

  it("not with what the screen only shows (its cost and what's left in dollars)", () => {
    expect(key({}, false, { cost: 60, leftUsdYear: 2 })).toBe(key());
  });
});

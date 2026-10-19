import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAbiItem, pad, type Hex, type Log } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { foldTransfers, type AlchemyTransfer, type TransferIn } from "@/lib/activity/alchemy";
import { arrivalTxs, arrivalsOf } from "@/lib/activity/arrivals";
import type { ActivityItem } from "@/lib/activity/decode";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, type MoveContext } from "@/lib/agents/feed";
import { feeBufferRaw, type Cash } from "@/lib/cash";
import {
  CASH_ROWS,
  arrivalCashRow,
  cashFromCreditUsd,
  cashRows,
  executorCashRow,
  ownCashRow,
  owedBeside,
  signedUsd,
  type ExecutorMove,
  type OwnMove,
} from "@/lib/cashActivity";
import { PROTOCOLS } from "@/lib/protocols/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const other: Address = "0x00000000000000000000000000000000000000ee";
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const T = Date.UTC(2026, 9, 15, 15, 0);
const own = (items: ActivityItem[], over: Partial<OwnMove> = {}): OwnMove => ({
  key: "k",
  time: T,
  status: "done",
  items,
  hash: tx(1),
  ...over,
});
const exec = (e: AgentEvent, ctx: MoveContext = {}, over: Partial<ExecutorMove> = {}): ExecutorMove => ({
  key: "e",
  time: T,
  hash: tx(2),
  event: e,
  ctx,
  details: describeAgentEvent(e, T / 1000, ctx)?.details ?? [],
  ...over,
});
const words = (r: { details: { label: string; value: readonly unknown[] }[] }) =>
  r.details.map((d) => `${d.label}: ${d.value.join("")}`);

describe("the credit beside the cash (no split of the cash)", () => {
  const cash: Cash = { walletRaw: usdc(1), savingsRaw: usdc(1_938.18), saveOn: true };

  it("shows nothing when nothing is owed", () => {
    expect(owedBeside(0, cash)).toBeNull();
  });

  it("shows what's owed, rounded up as on Home, and how it's repaid", () => {
    expect(owedBeside(64.2, cash)).toEqual({ owed: "$65", line: "Repay from your cash any time." });
    expect(owedBeside(64, cash)).toEqual({ owed: "$64", line: "Repay from your cash any time." });
  });

  it("asks for money first when the cash can't repay (the fee buffer stays for the network fee)", () => {
    // Exactly the buffer: none of it can repay.
    expect(owedBeside(300, { walletRaw: feeBufferRaw, savingsRaw: 0n, saveOn: false })?.line).toBe(
      "Top up your cash to repay.",
    );
    expect(owedBeside(300, { walletRaw: feeBufferRaw + 1n, savingsRaw: 0n, saveOn: false })?.line).toBe(
      "Repay from your cash any time.",
    );
  });

  it("counts credit as cash only when it came to the cash; a Credit Buy stays, its line saying what the credit paid", () => {
    const taken = ownCashRow(
      own([
        { kind: "supply", symbol: "TSLAc", amount: 1.32 },
        { kind: "borrow", symbol: "USDC", amount: 500 },
      ]),
    )!;
    expect([taken.title, taken.line]).toEqual(["From credit", "+$500.00"]);
    expect(words(taken)[0]).toBe("What: Backed by 1.32 TSLA");
    const creditBuy = ownCashRow(
      own([
        { kind: "borrow", symbol: "USDC", amount: 200 },
        { kind: "buy", symbol: "NVDAc", amount: 1.1, paidUsd: 200 },
      ]),
    )!;
    expect([creditBuy.title, creditBuy.line, creditBuy.usd]).toEqual(["Credit Buy NVIDIA", "$200.00 on credit", 0]);
  });

  it("Earn with stocks is one row: the credit that came to the cash, earning (its savings supply never left the cash)", () => {
    const earn = ownCashRow(
      own([
        { kind: "earn", symbol: "USDC", amount: 500 },
        { kind: "supply", symbol: "TSLAc", amount: 1.32 },
      ]),
    )!;
    expect([earn.title, earn.line, earn.usd]).toEqual(["Earn with stocks", "+$500.00 from credit, earning", 500]);
    expect(words(earn)[0]).toBe("What: Backed by 1.32 TSLA");
    // While it confirms, from this device's record (earnActivity), it reads the same.
    const pending = ownCashRow(own([{ kind: "earn", symbol: "USDC", amount: 500 }], { status: "pending" }))!;
    expect([pending.title, pending.line]).toEqual(["Earn with stocks", "+$500.00 from credit, earning · Confirming"]);
    // One row in the sheet: not "From credit", and not money sent.
    const rows = cashRows({
      own: [
        own([
          { kind: "earn", symbol: "USDC", amount: 500 },
          { kind: "supply", symbol: "TSLAc", amount: 1.32 },
        ]),
      ],
      executor: [],
      arrivals: [],
      since: 0,
    });
    expect(rows.map((r) => [r.title, r.line])).toEqual([["Earn with stocks", "+$500.00 from credit, earning"]]);
  });
});

describe("ownCashRow: the user's own moves, by what they did to the cash", () => {
  it("other dollars that became cash", () => {
    const r = ownCashRow(own([{ kind: "convert", symbol: "USDT", amount: 120, receivedUsd: 119.83 }]))!;
    expect([r.title, r.line, r.usd]).toEqual(["120 USDT became cash", "+$119.83", 119.83]);
    expect(words(r)[0]).toBe("What: 120 USDT → $119.83");
    const two = ownCashRow(
      own([
        { kind: "convert", symbol: "USDT", amount: 120, receivedUsd: 119.83 },
        { kind: "convert", symbol: "USDe", amount: 50, receivedUsd: 49.97 },
      ]),
    )!;
    expect([two.title, two.line]).toEqual(["USDT and USDe became cash", "+$169.80"]);
    expect(words(two).slice(0, 2)).toEqual(["What: 120 USDT → $119.83", ": 50 USDe → $49.97"]);
  });

  it("a buy reads as its cash part, with what credit paid in the details (decision 1)", () => {
    const r = ownCashRow(
      own([
        { kind: "borrow", symbol: "USDC", amount: 300 },
        { kind: "buy", symbol: "NVDAc", amount: 2.21, paidUsd: 400 },
      ]),
    )!;
    expect([r.title, r.line, r.mark]).toEqual([
      "Credit Buy NVIDIA",
      "−$100.00 · $300.00 on credit",
      { kind: "stock", symbol: "NVDAc" },
    ]);
    expect(words(r).slice(0, 2)).toEqual(["What: 2.21 NVDA", ": $300.00 of it on credit"]);
    const plain = ownCashRow(own([{ kind: "buy", symbol: "NVDAc", amount: 0.112, paidUsd: 20 }]))!;
    expect([plain.title, plain.line]).toEqual(["Bought NVIDIA", "−$20.00"]);
  });

  it("a sale, a repay, money in and money out", () => {
    const sold = ownCashRow(own([{ kind: "sell", symbol: "TSLAc", amount: 0.5, receivedUsd: 189.1 }]))!;
    expect([sold.title, sold.line]).toEqual(["Sold Tesla", "+$189.10"]);
    const repaid = ownCashRow(
      own([
        { kind: "repay", symbol: "USDC", amount: 60 },
        { kind: "withdraw", symbol: "NVDAc", amount: 0.4 },
      ]),
    )!;
    expect([repaid.title, repaid.line, words(repaid)[0]]).toEqual([
      "Repaid credit",
      "−$60.00",
      "What: Freed up 0.4 NVDA",
    ]);
    const received = ownCashRow(own([{ kind: "receive", symbol: "USDC", amount: 250 }]))!;
    expect([received.title, received.line]).toEqual(["Received", "+$250.00"]);
    const sent = ownCashRow(own([{ kind: "send", symbol: "USDC", amount: 20 }]))!;
    expect([sent.title, sent.line]).toEqual(["Sent", "−$20.00"]);
  });

  it("leaves out what moved no cash: backing in use or freed, stock in or out, and failures", () => {
    expect(ownCashRow(own([{ kind: "supply", symbol: "TSLAc", amount: 1 }]))).toBeNull();
    expect(ownCashRow(own([{ kind: "withdraw", symbol: "TSLAc", amount: 1 }]))).toBeNull();
    expect(ownCashRow(own([{ kind: "receive", symbol: "TSLAc", amount: 1 }]))).toBeNull();
    expect(ownCashRow(own([{ kind: "receive", symbol: "USDC", amount: 250 }], { status: "failed" }))).toBeNull();
    expect(ownCashRow(own([], { status: "pending" }))).toBeNull();
  });

  it("says Confirming while it confirms", () => {
    const r = ownCashRow(
      own([{ kind: "borrow", symbol: "USDC", amount: 500 }], { status: "pending", hash: undefined }),
    )!;
    expect(r.line).toBe("+$500.00 · Confirming");
    expect(words(r).at(-1)).toBe("Status: Confirming");
  });

  it("signs with the board's minus", () => {
    expect([signedUsd(1.5), signedUsd(-40)]).toEqual(["+$1.50", "−$40.00"]);
  });
});

describe("executorCashRow: the executor's moves in the cash", () => {
  it("hides Saves: earning moves nothing in the one pot (D20)", () => {
    expect(executorCashRow(exec({ kind: "saved", amountRaw: usdc(40) }))).toBeNull();
  });

  it("other dollars that became cash, with the feed's details", () => {
    const r = executorCashRow(
      exec({ kind: "converted", coin: ENTRY_COINS[0].address, amountInRaw: usdc(120), usdcOutRaw: usdc(119.83) }),
    )!;
    expect([r.title, r.line, r.mark]).toEqual(["120 USDT became cash", "+$119.83", { kind: "cash" }]);
    expect(words(r)[0]).toBe("Why: Dollars other than USDC become cash, at 99.5% of face value or better.");
  });

  it("Protect's repay from the cash", () => {
    const r = executorCashRow(
      exec({
        kind: "repaid",
        amountRaw: usdc(40),
        hfBefore: 1_050_000_000_000_000_000n,
        hfAfter: 1_200_000_000_000_000_000n,
        reason: "act",
      }),
    )!;
    expect([r.title, r.line, r.mark]).toEqual([
      "Protect repaid credit",
      "−$40.00",
      { kind: "agent", agent: "Protect" },
    ]);
  });

  it("a sale or a trade only when its swaps left the cash up by a cent or more", () => {
    const sold: AgentEvent = {
      kind: "sold",
      sharesRaw: [0n, 0n, 0n, 0n, 0n, 0n, 1n],
      repaidRaw: usdc(100),
      hfBefore: 1n,
      hfAfter: 2n,
      atOnce: true,
    };
    expect(executorCashRow(exec(sold, { cashRaw: [usdc(400), usdc(401.8)] }))).toMatchObject({
      title: "Protect sold backing stock",
      line: "+$1.80",
    });
    expect(executorCashRow(exec(sold, { cashRaw: [usdc(400), usdc(400.005)] }))).toBeNull();
    expect(executorCashRow(exec(sold))).toBeNull();
    const traded: AgentEvent = {
      kind: "rebalanced",
      soldRaw: [1n, 0n, 0n, 0n, 0n, 0n, 0n],
      boughtRaw: [0n, 0n, 0n, 0n, 0n, 1n, 0n],
    };
    expect(executorCashRow(exec(traded, { cashRaw: [usdc(400), usdc(401.12)] }))).toMatchObject({
      title: "Rebalance traded",
      line: "+$1.12",
      mark: { kind: "agent", agent: "Rebalance" },
    });
  });

  it("no row for switches, heads-ups, mixes or runs that didn't go through", () => {
    for (const e of [
      { kind: "job-on", job: "protect", capRaw: usdc(100), end: 1 },
      { kind: "heads-up", hf: 1n, sellValueRaw: 1n, sellAfter: 1 },
      { kind: "mix", weightsBps: [5_000, 0, 0, 0, 0, 5_000, 0] },
      { kind: "run-failed", reason: "0x", fails: 1 },
    ] as AgentEvent[]) {
      expect(executorCashRow(exec(e))).toBeNull();
    }
  });
});

const log = (
  address: Address,
  topics: ReturnType<typeof encodeEventTopics>,
  data: Hex,
  hash = tx(7),
  blockNumber = 100n,
) =>
  ({
    address,
    topics,
    data,
    blockHash: null,
    blockNumber,
    logIndex: 0,
    transactionHash: hash,
    transactionIndex: 0,
    removed: false,
  }) as unknown as Log;
const transfer = (from: Address, to: Address, value: bigint, hash?: Hex, block?: bigint) =>
  log(
    USDC.address,
    encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    encodeAbiParameters([{ type: "uint256" }], [value]),
    hash,
    block,
  );

describe("money someone else sent", () => {
  it("is the receipt's USDC receives of a cent or more, and nothing else", () => {
    expect(arrivalsOf([transfer(other, user, usdc(250))], user)).toEqual([
      { kind: "receive", symbol: "USDC", amount: 250 },
    ]);
    // Dust, as address-poisoning sends are.
    expect(arrivalsOf([transfer(other, user, 9_000n)], user)).toEqual([]);
  });

  it("drops what else the transaction did: its other half is never read", () => {
    const ev = getAbiItem({ abi: spokeAbi, name: "Borrow" });
    const topics = encodeEventTopics({
      abi: [ev],
      eventName: "Borrow",
      args: { reserveId: BigInt(USDC.reserveId), caller: user, user },
    });
    const borrow = log(
      AAVE.SPOKE,
      topics,
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [usdc(100), usdc(100)]),
    );
    expect(arrivalsOf([borrow, transfer(AAVE.HUB, user, usdc(100))], user)).toEqual([]);
    // Savings coming back is inside the cash (D15).
    expect(arrivalsOf([transfer(PROTOCOLS.AUSDC, user, usdc(40))], user)).toEqual([]);
  });

  /** Alchemy's record of one transfer to the account: its token, raw amount, transaction, block and time. */
  const record = (token: Address, raw: bigint, hash: Hex, block: number, iso = "2026-10-19T14:41:01.000Z") =>
    ({
      hash,
      blockNum: `0x${block.toString(16)}`,
      rawContract: { value: `0x${raw.toString(16)}`, address: token.toLowerCase() },
      metadata: { blockTimestamp: iso },
    }) as AlchemyTransfer;
  const fold = (records: AlchemyTransfer[]) => [...foldTransfers(new Map(), records).values()];
  const sentIn = (hash: Hex, block: bigint, usdcRaw: bigint, stock = false): TransferIn => ({
    hash,
    block,
    t: 1_792_420_861,
    usdcRaw,
    stock,
  });

  it("folds Alchemy's records into one per transaction: its USDC added up, any stock, its block and time", () => {
    expect(
      fold([
        record(USDC.address, usdc(1), tx(8), 10),
        record(EQUITIES[0].address, 5n, tx(8), 10),
        record(USDC.address, usdc(2), tx(8), 10),
        record(USDC.address, usdc(3), tx(9), 12),
      ]),
    ).toEqual([sentIn(tx(8), 10n, usdc(3), true), sentIn(tx(9), 12n, usdc(3))]);
  });

  it("reads each transaction once, newest first", () => {
    expect(arrivalTxs([sentIn(tx(8), 10n, usdc(4)), sentIn(tx(9), 12n, usdc(2))])).toEqual([
      sentIn(tx(9), 12n, usdc(2)),
      sentIn(tx(8), 10n, usdc(4)),
    ]);
  });

  it("leaves out transactions that brought under a cent in all, before any receipt is fetched", () => {
    const sent = fold([
      record(USDC.address, 9_999n, tx(5), 20), // dust: no receipt to fetch
      record(USDC.address, 6_000n, tx(6), 21), // two sub-cent transfers that add up to a cent or more
      record(USDC.address, 4_000n, tx(6), 21),
      record(USDC.address, 10_000n, tx(7), 22), // exactly a cent
    ]);
    expect(arrivalTxs(sent).map((t) => [t.hash, t.block])).toEqual([
      [tx(7), 22n],
      [tx(6), 21n],
    ]);
  });

  const stockTransfer = (from: Address, to: Address, value: bigint, hash?: Hex, block?: bigint) =>
    log(
      EQUITIES[0].address,
      encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
      encodeAbiParameters([{ type: "uint256" }], [value]),
      hash,
      block,
    );

  it("Activity also shows stocks someone sent, at any size; the Cash sheet only the cash", () => {
    const sent = [stockTransfer(other, user, 10n ** 15n)];
    expect(arrivalsOf(sent, user, true)).toEqual([
      { kind: "receive", symbol: EQUITIES[0].symbol, amount: 10 ** 15 / 10 ** EQUITIES[0].decimals },
    ]);
    expect(arrivalsOf(sent, user)).toEqual([]);
    expect(arrivalTxs(fold([record(EQUITIES[0].address, 1n, tx(4), 30)])).map((t) => t.hash)).toEqual([tx(4)]);
  });

  it("never counts the account's own batch as money sent to it", () => {
    // EntryPoint's UserOperationEvent with the account as its sender: a sale or a withdrawal paying the account.
    const userOp = log(
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      [
        "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f",
        tx(1),
        pad(user.toLowerCase() as Hex),
        pad("0x0000000000000000000000000000000000000000"),
      ],
      "0x",
    );
    expect(arrivalsOf([transfer(other, user, usdc(5)), userOp], user, true)).toEqual([]);
  });

  it("reads as Received, with no sender", () => {
    const r = arrivalCashRow({ hash: tx(9), time: T, items: [{ kind: "receive", symbol: "USDC", amount: 250 }] })!;
    expect([r.title, r.line, r.hash]).toEqual(["Received", "+$250.00", tx(9)]);
    expect(words(r).map((w) => w.split(":")[0])).toEqual(["When"]);
    expect(
      arrivalCashRow({ hash: tx(9), time: T, items: [{ kind: "receive", symbol: "USDC", amount: 0.004 }] }),
    ).toBeNull();
  });
});

describe("cashRows: the sheet's list", () => {
  const day = 86_400_000;
  it("merges the three, newest first, dedupes arrivals by transaction, and keeps the newest six", () => {
    const rows = cashRows({
      own: [
        own([{ kind: "receive", symbol: "USDC", amount: 10 }], { key: "a", time: T - 1 * day, hash: tx(1) }),
        own([{ kind: "send", symbol: "USDC", amount: 5 }], { key: "b", time: T - 2 * day, hash: tx(2) }),
      ],
      executor: [
        exec(
          { kind: "repaid", amountRaw: usdc(40), hfBefore: 1n, hfAfter: 2n, reason: "act" },
          {},
          { key: "c", time: T - 3 * day, hash: tx(3) },
        ),
      ],
      arrivals: [
        // Already the user's own row.
        { hash: tx(1), time: T - 1 * day, items: [{ kind: "receive", symbol: "USDC", amount: 10 }] },
        { hash: tx(4), time: T, items: [{ kind: "receive", symbol: "USDC", amount: 25 }] },
      ],
      since: T - 7 * day,
    });
    expect(rows.map((r) => r.title)).toEqual(["Received", "Received", "Sent", "Protect repaid credit"]);
    expect(rows.filter((r) => r.hash === tx(1))).toHaveLength(1);

    const many = Array.from({ length: 9 }, (_, i) =>
      own([{ kind: "receive", symbol: "USDC", amount: i + 1 }], {
        key: `m${i}`,
        time: T - i * 60_000,
        hash: tx(100 + i),
      }),
    );
    const six = cashRows({ own: many, executor: [], arrivals: [], since: 0 });
    expect(six).toHaveLength(CASH_ROWS);
    expect(six.map((r) => r.usd)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("cuts at the window's start, the same days as the executor's feed", () => {
    const rows = cashRows({
      own: [
        own([{ kind: "receive", symbol: "USDC", amount: 1 }], { key: "in", time: T - 6 * day, hash: tx(1) }),
        own([{ kind: "receive", symbol: "USDC", amount: 2 }], { key: "old", time: T - 8 * day, hash: tx(2) }),
      ],
      executor: [],
      arrivals: [{ hash: tx(3), time: T - 9 * day, items: [{ kind: "receive", symbol: "USDC", amount: 3 }] }],
      since: T - 7 * day,
    });
    expect(rows.map((r) => r.key)).toEqual(["in"]);
  });
});

describe("cashFromCreditUsd: the part of the cash that came from credit", () => {
  const move = (time: number, items: ActivityItem[], status: "done" | "pending" | "failed" = "done") => ({
    time,
    status,
    items,
  });
  const earn = (amount: number): ActivityItem => ({ kind: "earn", symbol: "USDC", amount });
  const repay = (amount: number): ActivityItem => ({ kind: "repay", symbol: "USDC", amount });

  it("Earn with stocks adds to it; a repay pays it back first", () => {
    expect(cashFromCreditUsd([move(1, [earn(100)])], 100, 500)).toBe(100);
    expect(cashFromCreditUsd([move(1, [earn(100)]), move(2, [repay(30)])], 70, 500)).toBe(70);
  });

  it("a Credit Buy's credit is spent at once and isn't in the cash; credit taken alone is", () => {
    const creditBuy = move(1, [
      { kind: "supply", symbol: "AAPLc", amount: 1 },
      { kind: "borrow", symbol: "USDC", amount: 50 },
      { kind: "buy", symbol: "MSFTc", amount: 0.1, paidUsd: 50 },
    ]);
    expect(cashFromCreditUsd([creditBuy], 50, 500)).toBe(0);
    expect(cashFromCreditUsd([move(1, [{ kind: "borrow", symbol: "USDC", amount: 20 }])], 20, 500)).toBe(20);
  });

  it("never more than what's owed or than the cash after the fuel tank; nothing while nothing is owed", () => {
    expect(cashFromCreditUsd([move(1, [earn(100)])], 40, 500)).toBe(40);
    expect(cashFromCreditUsd([move(1, [earn(100)])], 100, 25)).toBe(25);
    expect(cashFromCreditUsd([move(1, [earn(100)])], 0, 500)).toBe(0);
    expect(cashFromCreditUsd([move(1, [earn(100)], "pending")], 100, 500)).toBe(0);
  });

  it("goes in time order, whatever order the rows come in", () => {
    expect(cashFromCreditUsd([move(2, [earn(60)]), move(1, [repay(100)])], 60, 500)).toBe(60);
  });
});

import { isAddressEqual, type Hex } from "viem";
import type { ActivityItem } from "@/lib/activity/decode";
import { MIN_ARRIVAL_USD } from "@/lib/activity/arrivals";
import type { AgentEvent } from "@/lib/agents/events";
import type { AgentMove, MoveContext, Words } from "@/lib/agents/feed";
import { maxSpendRaw, toUsd, type Cash } from "@/lib/cash";
import { formatCoin, formatShares, formatUsd, formatUsdTrim, inWords, shortAddress } from "@/lib/formatting";
import { EQUITIES, USDC, tickerOf } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/*
 * The Cash sheet's activity (Adrian, 2026-10-15: "what was moved or converted, received and sent/pay"): only what
 * changed the cash, each row signed by how much. Cash is one pot (D20): earning moves nothing in it, so Saves make no
 * row here, and a buy or a repay reads as paid from cash. Pure, so every row's words are unit-tested.
 */

/**
 * What's owed beside the cash (rounded up, as on Home) and how it's repaid. Null when nothing is owed.
 */
export function owedBeside(debtUsd: number, cash: Cash): { owed: string; line: string } | null {
  if (debtUsd <= 0) return null;
  return {
    owed: formatUsdTrim(Math.ceil(debtUsd)),
    line: maxSpendRaw(cash) > 0n ? "Repay from your cash any time." : "Add money to your cash to repay.",
  };
}

/** A move as Activity has it, for the split of the cash: when, whether it landed, and what it moved. */
type CashMove = { time: number; status: "pending" | "done" | "failed"; items: readonly ActivityItem[] };

/**
 * The part of the cash that came from credit backed by stocks (Earn with stocks, or credit taken as cash), for the
 * Cash sheet's split. Nothing on chain says which dollars of the cash are credit, since credit is the same USDC as the
 * rest, so this is one plain convention: credit that came in as cash adds to it (an `earn` move, or credit taken
 * without a buy in the same batch: a Credit Buy spends its credit at once), and a repay pays it back first. Never
 * more than what's owed, nor than the cash left after the fuel tank. 0 while nothing is owed.
 */
export function cashFromCreditUsd(moves: readonly CashMove[], debtUsd: number, spendableUsd: number): number {
  if (debtUsd <= 0 || spendableUsd <= 0) return 0;
  let open = 0;
  for (const m of [...moves].filter((x) => x.status === "done").sort((a, b) => a.time - b.time)) {
    const bought = m.items.some((i) => i.kind === "buy");
    for (const i of m.items) {
      if (i.kind === "earn" || (i.kind === "borrow" && i.symbol === USDC.symbol && !bought)) open += i.amount;
      if (i.kind === "repay" && i.symbol === USDC.symbol) open = Math.max(0, open - i.amount);
    }
  }
  return Math.max(0, Math.min(open, debtUsd, spendableUsd));
}

/** Rows the sheet shows; "See all" opens Activity for the rest. */
export const CASH_ROWS = 6;
/** A change under a cent isn't a cash row (a pure Credit Buy's cash part is 0: the credit paid all of it). */
const MIN_USD = 0.01;

/** The round mark beside a row: the cash's green $, the stock's badge, or Protect's and Rebalance's marks. */
export type CashMark =
  | { kind: "cash" }
  | { kind: "stock"; symbol: string }
  | { kind: "agent"; agent: "Protect" | "Rebalance" };

type CashDetail = { label: string; value: Words };

export type CashRow = {
  key: string;
  /** When, in ms. */
  time: number;
  mark: CashMark;
  title: string;
  /** What it did to the cash, in dollars: in is positive. */
  usd: number;
  /** The line under the title: the change, signed, and "Confirming" while it does. */
  line: string;
  details: CashDetail[];
  hash?: Hex;
  pending: boolean;
};

/** The user's own move, as useActivity has it (JAW's history, its Base receipt, this device's sends). */
export type OwnMove = {
  key: string;
  time: number;
  status: "pending" | "done" | "failed";
  items: ActivityItem[];
  hash?: Hex;
};
/** The executor's move, as useAgentFeed has it: the event, what the chain said around it, and the feed's details. */
export type ExecutorMove = {
  key: string;
  time: number;
  hash: Hex;
  event: AgentEvent;
  ctx: MoveContext;
  details: AgentMove["details"];
};
/** Money someone else sent (lib/activity/arrivals.ts): the transaction, when, and its USDC receives. */
export type Arrival = { hash: Hex; time: number; items: ActivityItem[] };

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "+$100.00", "−$40.00" (U+2212, as on the boards). */
export const signedUsd = (usd: number) => `${usd < 0 ? "−" : "+"}${formatUsd(Math.abs(usd))}`;
/** Earn with stocks' line, here and in Activity: "+$500.00 from credit, earning". */
const earnLine = (usd: number) => `${signedUsd(usd)} from credit, earning`;
/** Start earning's line, here and in Activity: "$40.00 into savings" (the cash stayed the user's: no sign). */
const saveLine = (usd: number) => `${formatUsd(usd)} into savings`;
const cents = (usd: number) => Math.round(usd * 100) / 100;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const nameOf = (symbol: string) => EQUITIES.find((e) => e.symbol === symbol)?.name ?? tickerOf(symbol);
const shares = (i: ActivityItem) => `${formatShares(i.amount)} ${tickerOf(i.symbol)}`;
const isStock = (i: ActivityItem) => EQUITIES.some((e) => e.symbol === i.symbol);
const isUsdc = (i: ActivityItem) => i.symbol === USDC.symbol;

function row(
  p: Omit<CashRow, "line" | "details"> & { what: string[]; details?: CashDetail[]; lineText?: string },
): CashRow {
  const details: CashDetail[] = [
    ...p.what.map((w, k) => ({ label: k === 0 ? "What" : "", value: [w] })),
    ...(p.details ?? []),
    { label: "When", value: [WHEN.format(p.time)] },
    ...(p.pending ? [{ label: "Status", value: ["Confirming"] }] : []),
  ];
  return {
    key: p.key,
    time: p.time,
    mark: p.mark,
    title: p.title,
    usd: p.usd,
    line: `${p.lineText ?? signedUsd(p.usd)}${p.pending ? " · Confirming" : ""}`,
    details,
    hash: p.hash,
    pending: p.pending,
  };
}

/**
 * What one batch did to the cash: the buys, sales, conversions, repays and sends in it, the USDC credit it took, what
 * Earn with stocks put in to earn and Start earning put into savings, and the cash's change to the cent. In: credit
 * that came to the cash (none when a buy spent it in the same batch), what went in to earn, USDC received, what a sale
 * brought, what other dollars became. Out: USDC sent, repaid, and what a buy cost past its credit.
 */
function cashMoved(items: readonly ActivityItem[]) {
  const of = (kind: ActivityItem["kind"]) => items.filter((i) => i.kind === kind);
  const buys = of("buy");
  const sells = of("sell");
  const converts = of("convert");
  const repays = of("repay").filter(isUsdc);
  const receives = of("receive").filter(isUsdc);
  const sends = of("send").filter(isUsdc);
  const credit = sum(
    of("borrow")
      .filter(isUsdc)
      .map((i) => i.amount),
  );
  const earned = sum(of("earn").map((i) => i.amount));
  // Start earning: the cash went into savings. It's still the one pot (D20), so it moves nothing here, but it's a row.
  const saved = sum(of("save").map((i) => i.amount));
  const into =
    (buys.length ? 0 : credit) +
    earned +
    sum(receives.map((i) => i.amount)) +
    sum(sells.map((i) => i.receivedUsd ?? 0)) +
    sum(converts.map((i) => i.receivedUsd ?? 0));
  const out =
    sum(sends.map((i) => i.amount)) +
    sum(repays.map((i) => i.amount)) +
    sum(buys.map((i) => i.paidUsd ?? 0)) -
    (buys.length ? credit : 0);
  return { buys, sells, converts, repays, sends, credit, earned, saved, usd: cents(into - out) };
}

/**
 * One of the user's own moves as a cash row, or null when the cash didn't change by a cent (backing put in use or freed,
 * a pure Credit Buy) or it failed (nothing moved). In: credit that came to the cash (none when a buy spent it in the same
 * batch; Earn with stocks' credit, which went in to earn in the same batch, too), USDC received, what a sale brought,
 * what other dollars became. Out: USDC sent, repaid, and what a buy cost past its credit. Cash put into savings (Start
 * earning) is neither: it stays in the one pot, and is a row of its own. Titled by what matters most: a conversion, a
 * buy, a sale, a repay, Earn with stocks, credit, Start earning, money in, money out.
 */
export function ownCashRow(m: OwnMove): CashRow | null {
  if (m.status === "failed") return null;
  const of = (kind: ActivityItem["kind"]) => m.items.filter((i) => i.kind === kind);
  const { buys, sells, converts, repays, sends, credit, earned, saved, usd } = cashMoved(m.items);
  // A Credit Buy paid with credit leaves the cash as it was, but it's still the cash's story (Adrian: "I don't see the
  // credit buys"): it stays, its line saying what the credit paid.
  const creditBuy = buys.length > 0 && credit > 0;
  if (Math.abs(usd) < MIN_USD && !creditBuy && saved < MIN_USD) return null;

  const base = {
    key: m.key,
    time: m.time,
    usd,
    hash: m.hash,
    pending: m.status === "pending",
    mark: { kind: "cash" } as CashMark,
  };
  if (converts.length) {
    const coins = [...new Set(converts.map((c) => c.symbol))];
    const title =
      converts.length === 1
        ? `${formatCoin(converts[0].amount)} ${converts[0].symbol} became cash`
        : `${inWords(coins)} became cash`;
    return row({
      ...base,
      title,
      what: converts.map((c) => `${formatCoin(c.amount)} ${c.symbol} → ${formatUsd(c.receivedUsd ?? 0)}`),
    });
  }
  if (buys.length) {
    const what = buys.map(shares);
    if (credit > 0) what.push(`${formatUsd(credit)} of it on credit`);
    return row({
      ...base,
      mark: { kind: "stock", symbol: buys[0].symbol },
      title: credit > 0 ? `Credit Buy ${nameOf(buys[0].symbol)}` : `Bought ${nameOf(buys[0].symbol)}`,
      what,
      // Paid all on credit: the cash didn't move, so the line says the credit; part cash says both.
      ...(credit > 0
        ? {
            lineText:
              Math.abs(usd) < MIN_USD
                ? `${formatUsd(credit)} on credit`
                : `${signedUsd(usd)} · ${formatUsd(credit)} on credit`,
          }
        : {}),
    });
  }
  if (sells.length)
    return row({
      ...base,
      mark: { kind: "stock", symbol: sells[0].symbol },
      title: `Sold ${nameOf(sells[0].symbol)}`,
      what: sells.map(shares),
    });
  if (repays.length) {
    const freed = of("withdraw")
      .filter(isStock)
      .map((i) => `Freed up ${shares(i)}`);
    return row({ ...base, title: "Repaid credit", what: freed });
  }
  const backed = of("supply")
    .filter(isStock)
    .map((i) => `Backed by ${shares(i)}`);
  // Earn with stocks: one row for the whole batch, the credit that came to the cash, earning.
  if (earned > 0) return row({ ...base, title: "Earn with stocks", what: backed, lineText: earnLine(usd) });
  if (credit > 0) return row({ ...base, title: "From credit", what: backed });
  // Start earning: one row, "Started earning · $40.00 into savings", not money leaving.
  if (saved > 0 && Math.abs(usd) < MIN_USD)
    return row({ ...base, title: "Started earning", what: [], lineText: saveLine(saved) });
  // A Send names who it went to (the name this device sent it to, else the short address); a receive names no sender.
  const sentTo = usd < 0 && sends.length === 1 && sends[0].to ? (sends[0].toName ?? shortAddress(sends[0].to)) : null;
  return row({
    ...base,
    title: usd > 0 ? "Received" : "Sent",
    what: [],
    details: sentTo ? [{ label: "To", value: [sentTo] }] : undefined,
  });
}

/** A coin of the Entry agent's by address. */
const coinOf = (address: `0x${string}`) => ENTRY_COINS.find((c) => isAddressEqual(c.address, address));

/**
 * One of the executor's moves as a cash row, with the feed's own details: other dollars that became cash, Protect's
 * repay from the cash, and a sale or a trade only when its swaps left the cash up by a cent or more. Saves move nothing
 * in the one pot (D20), so they make no row; neither do switches, heads-ups, mixes or runs that didn't go through.
 */
export function executorCashRow(m: ExecutorMove): CashRow | null {
  const e = m.event;
  const base = { key: m.key, time: m.time, hash: m.hash, pending: false };
  const done = (r: Omit<CashRow, "line" | "details" | "key" | "time" | "hash" | "pending">): CashRow => ({
    ...base,
    ...r,
    line: signedUsd(r.usd),
    details: m.details,
  });
  switch (e.kind) {
    case "converted": {
      const c = coinOf(e.coin);
      const usd = toUsd(e.usdcOutRaw);
      const title = c
        ? `${formatCoin(Number(e.amountInRaw) / 10 ** c.decimals)} ${c.symbol} became cash`
        : "Other dollars became cash";
      return done({ mark: { kind: "cash" }, title, usd });
    }
    case "repaid":
      return done({
        mark: { kind: "agent", agent: "Protect" },
        title: "Protect repaid credit",
        usd: -toUsd(e.amountRaw),
      });
    case "sold":
    case "rebalanced": {
      const up = m.ctx.cashRaw ? m.ctx.cashRaw[1] - m.ctx.cashRaw[0] : 0n;
      if (toUsd(up) < MIN_USD) return null;
      return e.kind === "sold"
        ? done({ mark: { kind: "agent", agent: "Protect" }, title: "Protect sold backing stock", usd: toUsd(up) })
        : done({ mark: { kind: "agent", agent: "Rebalance" }, title: "Rebalance traded", usd: toUsd(up) });
    }
    default:
      return null;
  }
}

/**
 * Money someone else sent, as a cash row: its USDC of a cent or more. No sender is shown: address-poisoning sends copy
 * lookalike addresses.
 */
export function arrivalCashRow(a: Arrival): CashRow | null {
  const usd = cents(
    sum(a.items.filter((i) => i.kind === "receive" && isUsdc(i) && i.amount >= MIN_ARRIVAL_USD).map((i) => i.amount)),
  );
  if (usd < MIN_USD) return null;
  return row({
    key: `in:${a.hash}`,
    time: a.time,
    mark: { kind: "cash" },
    title: "Received",
    usd,
    hash: a.hash,
    pending: false,
    what: [],
  });
}

/**
 * The sheet's rows, newest first: the user's own moves since the window's start (`since`, ms), the executor's, and money
 * someone else sent in a transaction neither of those has, `limit` of them.
 */
export function cashRows(p: {
  own: readonly OwnMove[];
  executor: readonly ExecutorMove[];
  arrivals: readonly Arrival[];
  since: number;
  limit?: number;
}): CashRow[] {
  const known = new Set([...p.own, ...p.executor].flatMap((m) => (m.hash ? [m.hash.toLowerCase()] : [])));
  const rows = [
    ...p.own.filter((m) => m.time >= p.since).map(ownCashRow),
    ...p.executor.filter((m) => m.time >= p.since).map(executorCashRow),
    ...p.arrivals.filter((a) => a.time >= p.since && !known.has(a.hash.toLowerCase())).map(arrivalCashRow),
  ].filter((r): r is CashRow => r !== null);
  return rows.sort((a, b) => b.time - a.time).slice(0, p.limit ?? CASH_ROWS);
}

/** Which part of the Cash sheet's activity couldn't be read: all of it, or some (the rows that were read still show). */
export type CashFeedError = "all" | "some" | null;

type Read = { isError: boolean; isPending: boolean };

/**
 * Where the Cash sheet's reads stand: which part failed (`live`), and whether any is still reading. A source that isn't
 * read (no executor, no arrivals) neither fails nor keeps "all" from being true. `windowKnown`: the week's first block
 * is known, so the arrivals and its time are being read.
 */
export function cashFeedState(p: {
  executor: boolean;
  arrivals: boolean;
  windowKnown: boolean;
  own: { isError: boolean; isLoading: boolean };
  feed: { isError: boolean; isLoading: boolean };
  head: Read;
  transfers: Read;
  start: Read;
  txReads: readonly Read[];
}): { live: CashFeedError; reading: boolean } {
  const arrivalsFailed = p.arrivals && (p.head.isError || p.transfers.isError || p.txReads.some((q) => q.isError));
  const failed = [p.own.isError, p.executor && p.feed.isError, arrivalsFailed];
  const unread = [false, !p.executor, !p.arrivals];
  const live: CashFeedError = failed.every((f, i) => f || unread[i]) ? "all" : failed.some(Boolean) ? "some" : null;
  const reading =
    p.own.isLoading ||
    p.feed.isLoading ||
    p.head.isPending ||
    (p.windowKnown && ((p.arrivals && p.transfers.isPending) || p.start.isPending)) ||
    p.txReads.some((q) => q.isPending);
  return { live, reading };
}

import { isAddressEqual, type Hex } from "viem";
import type { ActivityItem } from "@/lib/activity/decode";
import { MIN_ARRIVAL_USD } from "@/lib/activity/arrivals";
import type { AgentEvent } from "@/lib/agents/events";
import type { AgentMove, MoveContext, Words } from "@/lib/agents/feed";
import { maxSpendRaw, toUsd, type Cash } from "@/lib/cash";
import { formatCoin, formatShares, formatUsd, formatUsdTrim, inWords, shortAddress } from "@/lib/formatting";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/*
 * The Cash sheet's activity (Adrian, 2026-10-15: "what was moved or converted, received and sent/pay"): only what
 * changed the cash, each row signed by how much. Cash is one pot (D20): earning moves nothing in it, so Saves make no
 * row here, and a buy or a repay reads as paid from cash. Pure, so every row's words are unit-tested.
 */

/**
 * The credit rule: the cash shows no "part from credit". Credit enters the cash only when it's taken as cash (Use
 * credit, Earn with stocks); a Credit Buy spends it inside the same batch. Once in, it is the same USDC as the rest:
 * Save sweeps it into the same savings, buys and repays and Protect spend from the one pot, and a repay lowers one
 * debt that mixes every kind of credit. So which dollars are "credit" is a convention nothing on chain records, and
 * min(cash, owed) would say a Credit Buy's debt sits in the cash when none of it ever did. What the sheet shows
 * instead, from live data only: what's owed beside the cash (rounded up, as on Home), how it's repaid, and every time
 * credit came in as its own row ("From credit"). Null when nothing is owed.
 */
export function owedBeside(debtUsd: number, cash: Cash): { owed: string; line: string } | null {
  if (debtUsd <= 0) return null;
  return {
    owed: formatUsdTrim(Math.ceil(debtUsd)),
    line: maxSpendRaw(cash) > 0n ? "Repay from your cash any time." : "Add money to your cash to repay.",
  };
}

/** Rows the sheet shows; "See all" opens Activity for the rest. */
export const CASH_ROWS = 6;
/** A change under a cent isn't a cash row (a pure Credit Buy's cash part is 0: the credit paid all of it). */
const MIN_USD = 0.01;

/** The round mark beside a row: the cash's green $, the stock's badge, or Protect's and Rebalance's marks. */
export type CashMark = { kind: "cash" } | { kind: "stock"; symbol: string } | { kind: "agent"; agent: "Protect" | "Rebalance" };

export type CashDetail = { label: string; value: Words };

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
export type OwnMove = { key: string; time: number; status: "pending" | "done" | "failed"; items: ActivityItem[]; hash?: Hex };
/** The executor's move, as useAgentFeed has it: the event, what the chain said around it, and the feed's details. */
export type ExecutorMove = { key: string; time: number; hash: Hex; event: AgentEvent; ctx: MoveContext; details: AgentMove["details"] };
/** Money someone else sent (lib/activity/arrivals.ts): the transaction, when, and its USDC receives. */
export type Arrival = { hash: Hex; time: number; items: ActivityItem[] };

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "+$100.00", "−$40.00" (U+2212, as on the boards). */
export const signedUsd = (usd: number) => `${usd < 0 ? "−" : "+"}${formatUsd(Math.abs(usd))}`;
const cents = (usd: number) => Math.round(usd * 100) / 100;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const ticker = (symbol: string) => symbol.replace(/c$/, "");
const nameOf = (symbol: string) => EQUITIES.find((e) => e.symbol === symbol)?.name ?? ticker(symbol);
const shares = (i: ActivityItem) => `${formatShares(i.amount)} ${ticker(i.symbol)}`;
const isStock = (i: ActivityItem) => EQUITIES.some((e) => e.symbol === i.symbol);
const isUsdc = (i: ActivityItem) => i.symbol === USDC.symbol;

function row(p: Omit<CashRow, "line" | "details"> & { what: string[]; details?: CashDetail[] }): CashRow {
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
    line: `${signedUsd(p.usd)}${p.pending ? " · Confirming" : ""}`,
    details,
    hash: p.hash,
    pending: p.pending,
  };
}

/**
 * One of the user's own moves as a cash row, or null when the cash didn't change by a cent (backing put in use or freed,
 * a pure Credit Buy) or it failed (nothing moved). In: credit that came to the cash (none when a buy spent it in the same
 * batch), USDC received, what a sale brought, what other dollars became. Out: USDC sent, repaid, and what a buy cost
 * past its credit. Titled by what matters most: a conversion, a buy, a sale, a repay, credit, money in, money out.
 */
export function ownCashRow(m: OwnMove): CashRow | null {
  if (m.status === "failed") return null;
  const of = (kind: ActivityItem["kind"]) => m.items.filter((i) => i.kind === kind);
  const buys = of("buy");
  const sells = of("sell");
  const converts = of("convert");
  const repays = of("repay").filter(isUsdc);
  const receives = of("receive").filter(isUsdc);
  const sends = of("send").filter(isUsdc);
  const credit = sum(of("borrow").filter(isUsdc).map((i) => i.amount));
  const into =
    (buys.length ? 0 : credit) + sum(receives.map((i) => i.amount)) + sum(sells.map((i) => i.receivedUsd ?? 0)) + sum(converts.map((i) => i.receivedUsd ?? 0));
  const out = sum(sends.map((i) => i.amount)) + sum(repays.map((i) => i.amount)) + sum(buys.map((i) => i.paidUsd ?? 0)) - (buys.length ? credit : 0);
  const usd = cents(into - out);
  if (Math.abs(usd) < MIN_USD) return null;

  const base = { key: m.key, time: m.time, usd, hash: m.hash, pending: m.status === "pending", mark: { kind: "cash" } as CashMark };
  if (converts.length) {
    const coins = [...new Set(converts.map((c) => c.symbol))];
    const title = converts.length === 1 ? `${formatCoin(converts[0].amount)} ${converts[0].symbol} became cash` : `${inWords(coins)} became cash`;
    return row({ ...base, title, what: converts.map((c) => `${formatCoin(c.amount)} ${c.symbol} → ${formatUsd(c.receivedUsd ?? 0)}`) });
  }
  if (buys.length) {
    const what = buys.map(shares);
    if (credit > 0) what.push(`${formatUsd(credit)} of it on credit`);
    return row({ ...base, mark: { kind: "stock", symbol: buys[0].symbol }, title: `Bought ${nameOf(buys[0].symbol)}`, what });
  }
  if (sells.length) return row({ ...base, mark: { kind: "stock", symbol: sells[0].symbol }, title: `Sold ${nameOf(sells[0].symbol)}`, what: sells.map(shares) });
  if (repays.length) {
    const freed = of("withdraw").filter(isStock).map((i) => `Freed up ${shares(i)}`);
    return row({ ...base, title: "Repaid credit", what: freed });
  }
  if (credit > 0) {
    const backed = of("supply").filter(isStock).map((i) => `Backed by ${shares(i)}`);
    return row({ ...base, title: "From credit", what: backed });
  }
  // A Send names who it went to (the name this device sent it to, else the short address); a receive names no sender.
  const sentTo = usd < 0 && sends.length === 1 && sends[0].to ? (sends[0].toName ?? shortAddress(sends[0].to)) : null;
  return row({ ...base, title: usd > 0 ? "Received" : "Sent", what: [], details: sentTo ? [{ label: "To", value: [sentTo] }] : undefined });
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
      const title = c ? `${formatCoin(Number(e.amountInRaw) / 10 ** c.decimals)} ${c.symbol} became cash` : "Other dollars became cash";
      return done({ mark: { kind: "cash" }, title, usd });
    }
    case "repaid":
      return done({ mark: { kind: "agent", agent: "Protect" }, title: "Protect repaid credit", usd: -toUsd(e.amountRaw) });
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
  const usd = cents(sum(a.items.filter((i) => i.kind === "receive" && isUsdc(i) && i.amount >= MIN_ARRIVAL_USD).map((i) => i.amount)));
  if (usd < MIN_USD) return null;
  return row({ key: `in:${a.hash}`, time: a.time, mark: { kind: "cash" }, title: "Received", usd, hash: a.hash, pending: false, what: [] });
}

/**
 * The sheet's rows, newest first: the user's own moves since the window's start (`since`, ms), the executor's, and money
 * someone else sent in a transaction neither of those has, `limit` of them.
 */
export function cashRows(p: { own: readonly OwnMove[]; executor: readonly ExecutorMove[]; arrivals: readonly Arrival[]; since: number; limit?: number }): CashRow[] {
  const known = new Set([...p.own, ...p.executor].flatMap((m) => (m.hash ? [m.hash.toLowerCase()] : [])));
  const rows = [
    ...p.own.filter((m) => m.time >= p.since).map(ownCashRow),
    ...p.executor.filter((m) => m.time >= p.since).map(executorCashRow),
    ...p.arrivals.filter((a) => a.time >= p.since && !known.has(a.hash.toLowerCase())).map(arrivalCashRow),
  ].filter((r): r is CashRow => r !== null);
  return rows.sort((a, b) => b.time - a.time).slice(0, p.limit ?? CASH_ROWS);
}

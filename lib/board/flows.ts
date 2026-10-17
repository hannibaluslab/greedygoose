import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { USDC_RESERVE_ID } from "./tokens";

/*
 * Money in and out of a member's account since joining, from its logs (lib/board/logs.ts reads them). Pure.
 *
 * Read one transaction at a time. A leg between the account and Aave or a swap pool counts as the account's own use of
 * GreedyGoose only when the same transaction shows the account doing it; anything else is money put in or taken out:
 * - Aave V4 (hub and spoke): a leg is the account's own only next to its own spoke event for that reserve (it is the
 *   caller and the position is its own): Supply or Repay for what it paid, Withdraw or Borrow for what it got.
 * - Aave V3 savings: USDC into the savings token is the account's own next to its own Supply or Repay; USDC out of it
 *   next to a Withdraw to the account or the account's own Borrow. Savings minted and burned are always its own, and
 *   savings taken by a liquidator of the account are its loss.
 * - Swap venues (the pools the app trades through and Spark's PSM3): a trade is the account paying a venue and that
 *   same venue paying it back in the same transaction. What a venue sends the account with nothing paid to it there
 *   (someone else's swap paid out to the account) is money put in; what the account pays a venue that sends it nothing
 *   back (a swap paid out to someone else) is money taken out.
 * - Everything else (a transfer of USDC, savings, another dollar coin or a stock to or from anyone, other members and
 *   the swap routers included) is money put in or taken out.
 * Aave acting on the account for someone else is money too: on V4 a caller who isn't the account supplying or repaying
 * for it (in) or withdrawing or drawing credit from it (out); on V3 savings supplied for it or withdrawn to it by
 * someone else (in), its savings withdrawn to someone else (out), its USDC credit repaid by someone else (in) or drawn
 * on its credit by someone else (out). The network fee JAW's paymaster takes in USDC (its UserOperationSponsored event
 * names the amount) is a cost, not money taken out, so it lowers the return.
 */

type Base = { block: bigint; tx: Hex; logIndex: number };
/** An ERC-20 Transfer of a tracked token. */
type TransferRec = Base & { kind: "transfer"; token: Address; from: Address; to: Address; value: bigint };
/**
 * An Aave V4 spoke event about a member's position. LiquidationCall: `reserveId` is the debt reserve, `amount` the
 * debt it cleared, `caller` the liquidator.
 */
type SpokeRec = Base & {
  kind: "spoke";
  event: "Supply" | "Withdraw" | "Borrow" | "Repay" | "LiquidationCall";
  reserveId: number;
  caller: Address;
  user: Address;
  amount: bigint;
};
/**
 * An Aave V3 savings event. Supply: `by` is who paid (msg.sender), `for` whose savings grew (onBehalfOf). Withdraw:
 * `by` whose savings shrank, `for` who got the USDC (to).
 */
type SavingsRec = Base & {
  kind: "savings";
  event: "Supply" | "Withdraw";
  reserve: Address;
  by: Address;
  for: Address;
  amount: bigint;
};
/**
 * Aave V3 credit, which a JAW account can draw against its savings in another app. `reserve` is the debt asset and
 * `debtor` the account whose debt changed. Borrow: `by` got the money (user). Repay: `by` paid (repayer). LiquidationCall:
 * `by` is the liquidator, `collateral` the asset it took, `aTokens` when it took them as savings rather than USDC.
 */
type SavingsCreditRec = Base & {
  kind: "savingsCredit";
  event: "Borrow" | "Repay" | "LiquidationCall";
  reserve: Address;
  debtor: Address;
  by: Address;
  amount: bigint;
  collateral?: Address;
  aTokens?: boolean;
};
/** JAW's paymaster took `amount` of `token` from `user` as the network fee (ERC-20 mode). */
type FeeRec = Base & { kind: "fee"; user: Address; token: Address; amount: bigint };
export type BoardRecord = TransferRec | SpokeRec | SavingsRec | SavingsCreditRec | FeeRec;

/** How a token counts: dollars (USDC, savings, other dollar coins at face value) or a stock at Aave's price. */
export type TokenInfo = { kind: "usd"; decimals: number } | { kind: "stock"; reserveId: number };

/** A dollar amount in USDC units (6 decimals), or a stock amount to value at Aave's price at `block`. */
export type Amount = { usd6: bigint } | { stock: { reserveId: number; raw: bigint } };
type Move = { block: bigint; dir: "in" | "out" } & Amount;
/** A trade: one venue, in one transaction, paid by the account and paying it back. */
type Swap = { block: bigint; venue: string; got: Amount[]; paid: Amount[] };
/** Credit in use changing: + drawn, − repaid or cleared by a liquidation (USDC units). */
type CreditStep = { block: bigint; logIndex: number; delta: bigint };
type MemberFlows = { moves: Move[]; swaps: Swap[]; credit: CreditStep[] };

export type FlowRules = {
  /** USDC on Base and Aave V3's savings token for it (aUSDC, which holds the savings' USDC). */
  usdc: Address;
  ausdc: Address;
  /** How each tracked token counts; undefined for anything else. */
  token: (address: Address) => TokenInfo | undefined;
  /**
   * The swap venue an address belongs to (lib/board/inside.ts): the pools the app trades through, and Spark's PSM3 with
   * the pocket that pays out its USDC (one venue). Undefined for anything else.
   */
  venue: (address: Address) => string | undefined;
  /** Aave V4's hub and spoke. */
  aave: (address: Address) => boolean;
};

const eq = (a: Address, b: Address) => isAddressEqual(a, b);
const order = (a: Base, b: Base) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
const toUsd6 = (value: bigint, decimals: number) =>
  decimals >= 6 ? value / 10n ** BigInt(decimals - 6) : value * 10n ** BigInt(6 - decimals);

/** A reserve's amount: USDC (reserve 7) in dollars, a stock by its reserve. */
const reserveAmount = (reserveId: number, raw: bigint): Amount =>
  reserveId === USDC_RESERVE_ID ? { usd6: raw } : { stock: { reserveId, raw } };

/** The moves in and out of `account` after its join block, its swaps and its credit steps, from `records` (any order). */
export function memberFlows(
  account: Address,
  joinedAt: bigint,
  records: readonly BoardRecord[],
  r: FlowRules,
): MemberFlows {
  // A log can come back from two queries (a transfer from one member to another is both "out" and "in").
  const seen = new Set<string>();
  const byTx = new Map<string, BoardRecord[]>();
  for (const x of records.filter((x) => x.block > joinedAt).sort(order)) {
    const key = `${x.tx.toLowerCase()}:${x.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tx = x.tx.toLowerCase();
    const list = byTx.get(tx);
    if (list) list.push(x);
    else byTx.set(tx, [x]);
  }
  const out: MemberFlows = { moves: [], swaps: [], credit: [] };
  for (const recs of byTx.values()) txFlows(account, recs, r, out);
  return out;
}

/** One transaction's records (in log order) into `out`. */
function txFlows(me: Address, recs: readonly BoardRecord[], r: FlowRules, out: MemberFlows) {
  const spoke = recs.filter((x): x is SpokeRec => x.kind === "spoke" && eq(x.user, me));
  const savings = recs.filter((x): x is SavingsRec => x.kind === "savings" && eq(x.reserve, r.usdc));
  const credit = recs.filter((x): x is SavingsCreditRec => x.kind === "savingsCredit");
  // Fees: each matches one transfer of exactly its amount, once.
  const fees = recs.filter((x): x is FeeRec => x.kind === "fee" && eq(x.user, me));

  /** The account's own spoke event for `reserveId`, of one of `events`, in this transaction. */
  const ownSpoke = (reserveId: number, events: SpokeRec["event"][]) =>
    spoke.some((s) => eq(s.caller, me) && s.reserveId === reserveId && events.includes(s.event));
  const ownCredit = (event: SavingsCreditRec["event"]) =>
    credit.some((c) => c.event === event && eq(c.reserve, r.usdc) && eq(c.debtor, me) && eq(c.by, me));

  /** Whether a leg between the account and Aave is the account's own use of it (see the top of this file). */
  function ownAaveLeg(token: Address, info: TokenInfo, other: Address, paid: boolean): boolean {
    if (r.aave(other)) {
      const reserveId = info.kind === "stock" ? info.reserveId : eq(token, r.usdc) ? USDC_RESERVE_ID : undefined;
      if (reserveId === undefined) return false;
      return ownSpoke(reserveId, paid ? ["Supply", "Repay"] : ["Withdraw", "Borrow"]);
    }
    if (eq(token, r.usdc) && eq(other, r.ausdc)) {
      return paid
        ? savings.some((s) => s.event === "Supply" && eq(s.by, me) && eq(s.for, me)) || ownCredit("Repay")
        : savings.some((s) => s.event === "Withdraw" && eq(s.for, me)) || ownCredit("Borrow");
    }
    if (eq(token, r.ausdc)) {
      // Savings minted and burned by the pool: the account's own supply and withdrawal, and the interest it earns.
      if (eq(other, zeroAddress)) return true;
      // Savings a liquidator of the account took: the liquidation's cost, not money taken out.
      if (paid)
        return credit.some(
          (c) =>
            c.event === "LiquidationCall" &&
            eq(c.debtor, me) &&
            eq(c.by, other) &&
            c.collateral !== undefined &&
            eq(c.collateral, r.usdc) &&
            !!c.aTokens,
        );
    }
    return false;
  }

  // Each venue's legs in this transaction, by venue.
  type Leg = { block: bigint; amount: Amount };
  const venues = new Map<string, { got: Leg[]; paid: Leg[] }>();
  for (const x of recs) {
    if (x.kind !== "transfer") continue;
    const info = r.token(x.token);
    if (!info || x.value === 0n) continue;
    const isOut = eq(x.from, me);
    if (isOut === eq(x.to, me)) continue; // not the member's, or to itself
    const other = isOut ? x.to : x.from;
    const amount: Amount =
      info.kind === "usd"
        ? { usd6: toUsd6(x.value, info.decimals) }
        : { stock: { reserveId: info.reserveId, raw: x.value } };
    const venue = r.venue(other);
    if (venue !== undefined) {
      const legs = venues.get(venue) ?? { got: [], paid: [] };
      (isOut ? legs.paid : legs.got).push({ block: x.block, amount });
      venues.set(venue, legs);
      continue;
    }
    if (ownAaveLeg(x.token, info, other, isOut)) continue;
    if (isOut) {
      const fee = fees.findIndex((f) => eq(f.token, x.token) && f.amount === x.value);
      if (fee >= 0) {
        fees.splice(fee, 1);
        continue;
      }
    }
    out.moves.push({ block: x.block, dir: isOut ? "out" : "in", ...amount });
  }
  for (const [venue, { got, paid }] of venues) {
    if (got.length && paid.length)
      out.swaps.push({ block: got[0].block, venue, got: got.map((l) => l.amount), paid: paid.map((l) => l.amount) });
    else
      for (const l of [...got, ...paid])
        out.moves.push({ block: l.block, dir: got.length ? "in" : "out", ...l.amount });
  }

  for (const x of spoke) {
    if (x.event === "LiquidationCall") {
      if (x.reserveId === USDC_RESERVE_ID) out.credit.push({ block: x.block, logIndex: x.logIndex, delta: -x.amount });
      continue;
    }
    if (x.reserveId === USDC_RESERVE_ID && (x.event === "Borrow" || x.event === "Repay")) {
      out.credit.push({ block: x.block, logIndex: x.logIndex, delta: x.event === "Borrow" ? x.amount : -x.amount });
    }
    if (eq(x.caller, me)) continue;
    // Someone else acting on the member's position: supplied or repaid for it is money in; withdrawn or drawn by
    // them (the money goes to the caller) is money out.
    const dir = x.event === "Supply" || x.event === "Repay" ? "in" : "out";
    out.moves.push({ block: x.block, dir, ...reserveAmount(x.reserveId, x.amount) });
  }
  for (const x of savings) {
    if (eq(x.by, x.for)) continue;
    if (x.event === "Supply" && eq(x.for, me)) out.moves.push({ block: x.block, dir: "in", usd6: x.amount });
    else if (x.event === "Withdraw" && eq(x.by, me)) out.moves.push({ block: x.block, dir: "out", usd6: x.amount });
    else if (x.event === "Withdraw" && eq(x.for, me)) out.moves.push({ block: x.block, dir: "in", usd6: x.amount });
  }
  for (const x of credit) {
    // Only USDC credit is in net worth (lib/board/worth.ts); another asset drawn reaches it only once it is turned into
    // something the board tracks, and then as money put in.
    if (!eq(x.reserve, r.usdc) || !eq(x.debtor, me)) continue;
    if (x.event === "LiquidationCall") {
      out.credit.push({ block: x.block, logIndex: x.logIndex, delta: -x.amount });
      continue;
    }
    out.credit.push({ block: x.block, logIndex: x.logIndex, delta: x.event === "Borrow" ? x.amount : -x.amount });
    // Someone else drew credit the member owes (the money went to them), or repaid the member's.
    if (!eq(x.by, me)) out.moves.push({ block: x.block, dir: x.event === "Repay" ? "in" : "out", usd6: x.amount });
  }
}

/**
 * Money put in and taken out, in USDC units: each move valued by `value` at its block (a stock at Aave's price then).
 * Trades aren't in it: what one costs (the pool's fee, its price against Aave's) shows in net worth.
 */
export function flowTotals(
  f: MemberFlows,
  value: (a: Amount, block: bigint) => bigint,
): { putIn: bigint; takenOut: bigint } {
  let putIn = 0n;
  let takenOut = 0n;
  for (const m of f.moves) {
    if (m.dir === "in") putIn += value(m, m.block);
    else takenOut += value(m, m.block);
  }
  return { putIn, takenOut };
}

/** The blocks whose stock prices `flowTotals` needs: where a stock moved in or out. */
export function priceBlocks(f: MemberFlows): bigint[] {
  return [...new Set(f.moves.filter((m) => "stock" in m).map((m) => m.block))];
}

/** Whether nothing happened to the account after joining that the board can see. */
export const quiet = (f: MemberFlows) => !f.moves.length && !f.swaps.length && !f.credit.length;

/** The most credit in use at once: at joining, after each step, and now. */
export function peakCredit(atJoin: bigint, steps: readonly CreditStep[], now: bigint): bigint {
  let debt = atJoin;
  let peak = atJoin > now ? atJoin : now;
  for (const s of [...steps].sort((a, b) =>
    a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1,
  )) {
    debt += s.delta;
    if (debt < 0n) debt = 0n;
    if (debt > peak) peak = debt;
  }
  return peak;
}

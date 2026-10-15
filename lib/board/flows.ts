import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { USDC_RESERVE_ID } from "./tokens";

/*
 * Money in and out of a member's account since joining, from its logs (lib/board/logs.ts reads them). Pure.
 *
 * A move between the account and a place that is part of using GreedyGoose (Aave, a swap pool, the agents) is inside
 * the account: it changes what the account holds, not how much money was put in, and net worth already shows its
 * effect (a price, a fee, a penalty). Everything else is money put in or taken out:
 * - a transfer of USDC, savings (aUSDC), another dollar coin or a stock from or to anyone else, other members included;
 * - Aave V4 acting on the member's position for someone else (`caller` isn't the member): stock or USDC supplied or
 *   repaid for the member is money put in, a withdrawal or credit drawn by someone else is money taken out;
 * - Aave V3 savings supplied for the member by someone else, or withdrawn to someone else, or someone else's savings
 *   withdrawn to the member. The member's own savings moves are inside (USDC to and from the aUSDC contract, aUSDC
 *   minted and burned).
 * The network fee JAW's paymaster takes in USDC (its UserOperationSponsored event names the amount) is a cost, not
 * money taken out, so it lowers the return.
 */

type Base = { block: bigint; tx: Hex; logIndex: number };
/** An ERC-20 Transfer of a tracked token. */
export type TransferRec = Base & { kind: "transfer"; token: Address; from: Address; to: Address; value: bigint };
/**
 * An Aave V4 spoke event about a member's position. LiquidationCall: `reserveId` is the debt reserve, `amount` the
 * debt it cleared, `caller` the liquidator.
 */
export type SpokeRec = Base & {
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
export type SavingsRec = Base & { kind: "savings"; event: "Supply" | "Withdraw"; reserve: Address; by: Address; for: Address; amount: bigint };
/** JAW's paymaster took `amount` of `token` from `user` as the network fee (ERC-20 mode). */
export type FeeRec = Base & { kind: "fee"; user: Address; token: Address; amount: bigint };
export type BoardRecord = TransferRec | SpokeRec | SavingsRec | FeeRec;

/** How a token counts: dollars (USDC, savings, other dollar coins at face value) or a stock at Aave's price. */
export type TokenInfo = { kind: "usd"; decimals: number } | { kind: "stock"; reserveId: number };

/** A dollar amount in USDC units (6 decimals), or a stock amount to value at Aave's price at `block`. */
export type Amount = { usd6: bigint } | { stock: { reserveId: number; raw: bigint } };
export type Move = { block: bigint; dir: "in" | "out" } & Amount;
/** Credit in use changing: + drawn, − repaid or cleared by a liquidation (USDC units). */
export type CreditStep = { block: bigint; logIndex: number; delta: bigint };
export type MemberFlows = { moves: Move[]; credit: CreditStep[] };

export type FlowRules = {
  /** USDC on Base, the savings token and the savings pool, for the member's own savings moves. */
  usdc: Address;
  ausdc: Address;
  /** How each tracked token counts; undefined for anything else. */
  token: (address: Address) => TokenInfo | undefined;
  /** Places that are part of using GreedyGoose: Aave V4, swap pools, the agents (lib/board/inside.ts). */
  inside: (address: Address) => boolean;
};

const eq = (a: Address, b: Address) => isAddressEqual(a, b);
const order = (a: Base, b: Base) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
const toUsd6 = (value: bigint, decimals: number) => (decimals >= 6 ? value / 10n ** BigInt(decimals - 6) : value * 10n ** BigInt(6 - decimals));

/** A reserve's amount: USDC (reserve 7) in dollars, a stock by its reserve. */
const reserveAmount = (reserveId: number, raw: bigint): Amount =>
  reserveId === USDC_RESERVE_ID ? { usd6: raw } : { stock: { reserveId, raw } };

/** Whether a transfer's other side is inside the account for this token. */
function insideLeg(r: FlowRules, token: Address, other: Address): boolean {
  if (r.inside(other)) return true;
  // The member's own savings: USDC into or out of the aUSDC contract, aUSDC minted or burned. Savings moved for or by
  // someone else show up as V3 Supply / Withdraw events instead.
  if (eq(token, r.usdc) && eq(other, r.ausdc)) return true;
  if (eq(token, r.ausdc) && eq(other, zeroAddress)) return true;
  return false;
}

/** The moves in and out of `account` after its join block, and its credit steps, from `records` (any order). */
export function memberFlows(account: Address, joinedAt: bigint, records: readonly BoardRecord[], r: FlowRules): MemberFlows {
  const mine = records.filter((x) => x.block > joinedAt).sort(order);
  // Fees by transaction: each matches one transfer of exactly its amount, once.
  const fees = mine.filter((x): x is FeeRec => x.kind === "fee" && eq(x.user, account));
  const moves: Move[] = [];
  const credit: CreditStep[] = [];
  const seen = new Set<string>();

  for (const x of mine) {
    // A log can come back from two queries (a transfer from one member to another is both "out" and "in").
    const key = `${x.tx}:${x.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (x.kind === "transfer") {
      const info = r.token(x.token);
      if (!info || x.value === 0n) continue;
      const out = eq(x.from, account);
      const into = eq(x.to, account);
      if (out === into) continue; // not the member's, or to itself
      const other = out ? x.to : x.from;
      if (insideLeg(r, x.token, other)) continue;
      if (out) {
        const fee = fees.findIndex((f) => f.tx === x.tx && eq(f.token, x.token) && f.amount === x.value);
        if (fee >= 0) {
          fees.splice(fee, 1);
          continue;
        }
      }
      const amount: Amount = info.kind === "usd" ? { usd6: toUsd6(x.value, info.decimals) } : { stock: { reserveId: info.reserveId, raw: x.value } };
      moves.push({ block: x.block, dir: out ? "out" : "in", ...amount });
    } else if (x.kind === "spoke") {
      if (!eq(x.user, account)) continue;
      const byOther = !eq(x.caller, account);
      if (x.event === "LiquidationCall") {
        if (x.reserveId === USDC_RESERVE_ID) credit.push({ block: x.block, logIndex: x.logIndex, delta: -x.amount });
        continue;
      }
      if (x.reserveId === USDC_RESERVE_ID && (x.event === "Borrow" || x.event === "Repay")) {
        credit.push({ block: x.block, logIndex: x.logIndex, delta: x.event === "Borrow" ? x.amount : -x.amount });
      }
      if (!byOther) continue;
      // Someone else acting on the member's position: supplied or repaid for it is money in; withdrawn or drawn by
      // them (the money goes to the caller) is money out.
      const dir = x.event === "Supply" || x.event === "Repay" ? "in" : "out";
      moves.push({ block: x.block, dir, ...reserveAmount(x.reserveId, x.amount) });
    } else if (x.kind === "savings") {
      if (!eq(x.reserve, r.usdc) || eq(x.by, x.for)) continue;
      if (x.event === "Supply" && eq(x.for, account)) moves.push({ block: x.block, dir: "in", usd6: x.amount });
      else if (x.event === "Withdraw" && eq(x.by, account)) moves.push({ block: x.block, dir: "out", usd6: x.amount });
      else if (x.event === "Withdraw" && eq(x.for, account)) moves.push({ block: x.block, dir: "in", usd6: x.amount });
    }
  }
  return { moves, credit };
}

/** The most credit in use at once: at joining, after each step, and now. */
export function peakCredit(atJoin: bigint, steps: readonly CreditStep[], now: bigint): bigint {
  let debt = atJoin;
  let peak = atJoin > now ? atJoin : now;
  for (const s of [...steps].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1))) {
    debt += s.delta;
    if (debt < 0n) debt = 0n;
    if (debt > peak) peak = debt;
  }
  return peak;
}

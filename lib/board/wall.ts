import type { Address } from "viem";
import { leverageOf } from "@/lib/leverage";
import { EQUITIES } from "@/lib/tokens/registry";
import { stockUsd6, type Holdings, type Prices } from "./worth";

/*
 * Greedy Fatalities, the Wall of shame (SPEC.md › Leaderboard, JUSTALAB-DECISIONS.md 2026-10-21): every member who had
 * part of their stock sold to pay their credit is named, boldest first, by their leverage when it happened. Pure; the
 * reads are lib/board/read.ts's readWall.
 *
 * - Which sales: Aave V4's LiquidationCall on the spoke, where what was sold is one of the stocks. Aave V3's don't
 *   count: they sell savings that back credit drawn in another app, not stock.
 * - From when: after the Wall opened (WALL_FROM_BLOCK) and after the account first joined. Leaving the board doesn't
 *   take anyone off the Wall: an account that joined by the Wall's opening block counts from it, one that joined later
 *   from its first Joined event, so a leave() and a join() again don't move it.
 * - The multiple: Home's leverage (lib/leverage.ts), what they held ÷ what was theirs, from what they held at the end of
 *   the block before the sale, valued at Aave's prices in the sale's own block. A sale usually lands in the same block
 *   as the price update that set it off, and the block before still has the old price.
 * - One row per account, at its highest multiple. Nothing of their own left at the sale ranks above every multiple.
 */

/** A sale of a stock to pay a member's credit: Aave V4's LiquidationCall, as lib/board/logs.ts decodes it. */
export type WallSale = { account: Address; block: bigint; tx: `0x${string}`; logIndex: number; stockReserveId: number };

/** GooseBoard's Joined event: `account` joined in `block`. */
export type WallJoin = { account: Address; block: bigint };

/** Leverage at the sale, or "wiped" when what they held no longer covered what they owed. */
type WallMultiple = number | "wiped";

export type WallRow = { account: Address; block: bigint; multiple: WallMultiple; rank: number };

const lower = (a: string) => a.toLowerCase();
const isStock = (reserveId: number) => EQUITIES.some((e) => e.reserveId === reserveId);

/**
 * The block after which each member's sales count, by lowercase address: the Wall's opening block for everyone on the
 * board by then (`before`, the first `memberCount` entries of GooseBoard's list at that block), else the block of the
 * account's first Joined event after it.
 */
export function wallSince(p: {
  from: bigint;
  before: readonly Address[];
  joins: readonly WallJoin[];
}): Map<string, bigint> {
  const since = new Map<string, bigint>();
  for (const a of p.before) since.set(lower(a), p.from);
  for (const j of p.joins) {
    if (j.block <= p.from) continue;
    const key = lower(j.account);
    const seen = since.get(key);
    if (seen === undefined || j.block < seen) since.set(key, j.block);
  }
  return since;
}

/** The sales that put someone on the Wall: a stock sold, of a member, after the block it counts from. Each log once. */
export function countedSales(sales: readonly WallSale[], since: ReadonlyMap<string, bigint>): WallSale[] {
  const seen = new Set<string>();
  return sales.filter((s) => {
    const from = since.get(lower(s.account));
    if (from === undefined || s.block <= from || !isStock(s.stockReserveId)) return false;
    const key = `${lower(s.tx)}:${s.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Home's leverage from what a member held (`h`, raw units) at Aave's `prices`: dollars and stocks, the backing
 * included, ÷ that less what's owed. "wiped" when nothing of their own was left; null when nothing was owed.
 */
export function saleMultiple(h: Holdings, prices: Prices): WallMultiple | null {
  const hold6 = h.usd6 + h.stocksRaw.reduce((sum, raw, r) => sum + stockUsd6(raw, prices[r]), 0n);
  if (h.debt6 <= 0n) return null;
  if (hold6 <= h.debt6) return "wiped";
  return leverageOf({ holdUsd: Number(hold6) / 1e6, owedUsd: Number(h.debt6) / 1e6 });
}

/** Higher first: "wiped" above every multiple. */
const cmpMultiple = (a: WallMultiple, b: WallMultiple) =>
  a === b ? 0 : a === "wiped" ? -1 : b === "wiped" ? 1 : b - a;
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One row per account at its highest multiple (the earliest sale on a tie), boldest first; ties go to the earlier
 * sale, then by address, so the order is the same on every phone.
 */
export function rankWall(sales: readonly { account: Address; block: bigint; multiple: WallMultiple }[]): WallRow[] {
  const best = new Map<string, { account: Address; block: bigint; multiple: WallMultiple }>();
  for (const s of sales) {
    const key = lower(s.account);
    const held = best.get(key);
    if (!held || cmpMultiple(s.multiple, held.multiple) < 0 || (s.multiple === held.multiple && s.block < held.block))
      best.set(key, s);
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        cmpMultiple(a.multiple, b.multiple) ||
        cmpBig(a.block, b.block) ||
        lower(a.account).localeCompare(lower(b.account)),
    )
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

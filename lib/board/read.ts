import type { Address, Client } from "viem";
import { getBlockNumber, readContract } from "viem/actions";
import { gooseBoardAbi } from "./abi";
import { flowTotals, memberFlows, peakCredit, priceBlocks, quiet, type Amount, type FlowRules } from "./flows";
import { AAVE_V4_PLACES, readVenues } from "./inside";
import { limiter } from "./limit";
import { readBoardRecords } from "./logs";
import { rankRows, returnSinceJoining } from "./score";
import { tokenInfo } from "./tokens";
import { readHoldings, readPrices, stockUsd6, worth6, type Holdings, type Prices } from "./worth";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

type Member = { account: Address; joinedAt: bigint };

/** One row of the board: percent only. `pct` is null and `rank` is null for a member who isn't ranked yet. */
type BoardRow = Member & { pct: number | null; rank: number | null };

type Board = { head: bigint; rows: BoardRow[] };

/** Members per page() call. */
const PAGE = 500n;
/**
 * State reads in flight at once (members, holdings, prices), however many members there are: a public node turns a
 * burst away. The log reads have their own four (lib/board/logs.ts).
 */
const stateLimit = limiter(4);
/** Past state is kept, in memory and this browser's storage, once the chain is this many blocks past it. */
const SETTLED = 64n;
/**
 * An account the board saw nothing happen to since joining (no money in or out, no trade, no credit) that holds under
 * $1 now isn't ranked, and its join block isn't read: it never put money in, or it joined empty. It ranks once it
 * moves money. This keeps accounts that join and do nothing from costing every phone a past-state read each.
 */
const IDLE_USD6 = 1_000_000n;

/** Everyone on the board now, in the order they first joined, as of `blockNumber`. */
async function readMembers(client: Client, board: Address, blockNumber: bigint): Promise<Member[]> {
  const count = await stateLimit(() =>
    readContract(client, { address: board, abi: gooseBoardAbi, functionName: "memberCount", blockNumber }),
  );
  const starts: bigint[] = [];
  for (let start = 0n; start < count; start += PAGE) starts.push(start);
  const pages = await Promise.all(
    starts.map((start) =>
      stateLimit(() =>
        readContract(client, {
          address: board,
          abi: gooseBoardAbi,
          functionName: "page",
          args: [start, PAGE],
          blockNumber,
        }),
      ),
    ),
  );
  const out: Member[] = [];
  for (const [accounts, onBoard, joinedAt] of pages) {
    accounts.forEach((account, i) => {
      if (onBoard[i]) out.push({ account, joinedAt: joinedAt[i] });
    });
  }
  return out;
}

/* ── past state, kept: prices at a block and holdings at a join block never change once settled ── */

const STORE = "gg.board.v2.";
const big = (v: unknown) => BigInt(v as string);
function load<T>(key: string, decode: (raw: unknown) => T): T | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(STORE + key);
    return raw ? decode(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}
function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(
      STORE + key,
      JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  } catch {
    /* storage full or blocked: memory still has it */
  }
}

type Ctx = { state: Client; board: Address; head: bigint };
const pricesAt = new Map<string, Promise<Prices>>();
const holdingsAt = new Map<string, Promise<Holdings>>();
let venuesOnce: Promise<Map<string, string>> | undefined;

/** Aave's prices at `block`, read once (keyed by board, so a fork's blocks never mix with Base's). */
function prices(c: Ctx, block: bigint): Promise<Prices> {
  const key = `price:${c.board.toLowerCase()}:${block}`;
  let p = pricesAt.get(key);
  if (p) return p;
  const settled = block + SETTLED <= c.head;
  const kept = settled ? load(key, (raw) => (raw as unknown[]).map(big)) : undefined;
  p = kept
    ? Promise.resolve(kept)
    : readPrices(c.state, block, stateLimit).then((v) => {
        if (settled) save(key, v);
        return v;
      });
  p.catch(() => pricesAt.delete(key));
  // Only a settled block's prices are kept in memory; head's are read again next time.
  if (settled) pricesAt.set(key, p);
  return p;
}

const holdKey = (c: Ctx, m: Member) => `hold:${c.board.toLowerCase()}:${m.account.toLowerCase()}@${m.joinedAt}`;
const decodeHoldings = (raw: unknown): Holdings => {
  const h = raw as { usd6: string; stocksRaw: string[]; debt6: string };
  return { usd6: big(h.usd6), stocksRaw: h.stocksRaw.map(big), debt6: big(h.debt6) };
};

/** What each of `members` held at the end of its join block; members who joined in the same block share a read. */
async function holdingsAtJoin(c: Ctx, members: readonly Member[]): Promise<Map<string, Holdings>> {
  const missing = new Map<bigint, Member[]>();
  for (const m of members) {
    const key = holdKey(c, m);
    if (holdingsAt.has(key)) continue;
    const kept = m.joinedAt + SETTLED <= c.head ? load(key, decodeHoldings) : undefined;
    if (kept) holdingsAt.set(key, Promise.resolve(kept));
    else missing.set(m.joinedAt, [...(missing.get(m.joinedAt) ?? []), m]);
  }
  for (const [block, group] of missing) {
    const read = readHoldings(
      c.state,
      group.map((m) => m.account),
      block,
      stateLimit,
    );
    group.forEach((m, i) => {
      const key = holdKey(c, m);
      const one = read.then((h) => {
        if (block + SETTLED <= c.head) save(key, h[i]);
        return h[i];
      });
      one.catch(() => holdingsAt.delete(key));
      holdingsAt.set(key, one);
    });
  }
  const out = new Map<string, Holdings>();
  await Promise.all(members.map(async (m) => out.set(holdKey(c, m), await holdingsAt.get(holdKey(c, m))!)));
  return out;
}

const dollars = (usd6: bigint) => Number(usd6) / 10 ** USDC.decimals;

/**
 * The whole board, as of the last block both clients have: members from GooseBoard, their logs since joining
 * (`logs`, an RPC that serves eth_getLogs), what they held when they joined and now (`state`, which must serve past
 * state), and Aave's price for every stock that moved in or out when it moved. Throws when any read fails, so the
 * screen says it couldn't load the board rather than showing rows that might be wrong.
 */
export async function readBoard(p: { state: Client; logs: Client; board: Address }): Promise<Board> {
  const [stateHead, logsHead] = await Promise.all([
    getBlockNumber(p.state, { cacheTime: 0 }),
    getBlockNumber(p.logs, { cacheTime: 0 }),
  ]);
  const head = stateHead < logsHead ? stateHead : logsHead;
  const c: Ctx = { state: p.state, board: p.board, head };
  // A member whose join block is past what both nodes have shows up on the next read.
  const members = (await readMembers(p.state, p.board, head)).filter((m) => m.joinedAt <= head);
  if (!members.length) return { head, rows: [] };

  venuesOnce ??= stateLimit(() => readVenues(p.state)).catch((e) => {
    venuesOnce = undefined;
    throw e;
  });
  const [venues, records, now, pricesNow] = await Promise.all([
    venuesOnce,
    readBoardRecords(p.logs, p.board, members, head),
    readHoldings(
      p.state,
      members.map((m) => m.account),
      head,
      stateLimit,
    ),
    prices(c, head),
  ]);
  const rules: FlowRules = {
    usdc: USDC.address,
    ausdc: PROTOCOLS.AUSDC,
    token: tokenInfo,
    venue: (a) => venues.get(a.toLowerCase()),
    aave: (a) => AAVE_V4_PLACES.some((b) => b.toLowerCase() === a.toLowerCase()),
  };

  const flows = members.map((m) => memberFlows(m.account, m.joinedAt, records, rules));
  const worthNow = now.map((h) => worth6(h, pricesNow));
  const scored = members.map((_, i) => !(quiet(flows[i]) && worthNow[i] < IDLE_USD6));

  const atJoin = await holdingsAtJoin(
    c,
    members.filter((_, i) => scored[i]),
  );
  // Join blocks need their prices, and so do the blocks where a stock moved in or out.
  const blocks = new Set<bigint>();
  members.forEach((m, i) => {
    if (!scored[i]) return;
    blocks.add(m.joinedAt);
    for (const b of priceBlocks(flows[i])) blocks.add(b);
  });
  const priceByBlock = new Map<bigint, Prices>(
    await Promise.all([...blocks].map(async (b) => [b, await prices(c, b)] as const)),
  );
  const value = (a: Amount, block: bigint) =>
    "usd6" in a ? a.usd6 : stockUsd6(a.stock.raw, priceByBlock.get(block)![a.stock.reserveId]);

  const rows = members.map((m, i) => {
    if (!scored[i]) return { ...m, pct: null };
    const join = atJoin.get(holdKey(c, m))!;
    const { putIn, takenOut } = flowTotals(flows[i], value);
    const score = returnSinceJoining({
      worthAtJoin: dollars(worth6(join, priceByBlock.get(m.joinedAt)!)),
      worthNow: dollars(worthNow[i]),
      putIn: dollars(putIn),
      takenOut: dollars(takenOut),
      peakCredit: dollars(peakCredit(join.debt6, flows[i].credit, now[i].debt6)),
    });
    return { ...m, pct: score.pct };
  });
  return { head, rows: rankRows(rows) };
}

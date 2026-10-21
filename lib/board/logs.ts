import {
  erc20Abi,
  formatLog,
  getAbiItem,
  isAddressEqual,
  pad,
  parseAbi,
  parseEventLogs,
  toEventSelector,
  toHex,
  type Address,
  type Client,
  type Hex,
  type Log,
  type RpcLog,
} from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { PROTOCOLS } from "@/lib/protocols/config";
import { gooseBoardAbi } from "./abi";
import { BOARD_LOG_CHUNK } from "./config";
import type { BoardRecord } from "./flows";
import { BOARD_TOKENS } from "./tokens";
import type { WallJoin, WallSale } from "./wall";

/**
 * The logs the board scores members from, read per 10,000-block chunk for every member at once (no indexer, D12):
 *   1. transfers of a tracked token from a member,
 *   2. transfers of a tracked token to a member,
 *   3. Aave V4 spoke events about a member's position, Aave V3 savings withdrawn to a member and Aave V3
 *      liquidations of a member,
 *   4. Aave V3 savings supplied for or withdrawn by a member, Aave V3 USDC credit drawn on or repaid for a member, and
 *      JAW's paymaster's fee records for a member.
 * A chunk the chain has moved past never changes, so it is read once and kept (in memory and, when it can, this
 * browser's storage).
 */

/** JAW's ERC-20 paymaster (@jaw.id/core's ERC20_PAYMASTER_ADDRESS, Pimlico's singleton paymaster on Base). */
export const JAW_PAYMASTER: Address = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";

/**
 * Aave V3's Pool events (aave-v3-origin IPool). Supply, Withdraw, Borrow and Repay checked against the pool's logs on
 * Base 2026-10-15 (topics and data as decoded here); LiquidationCall is the same interface's.
 */
export const savingsEventsAbi = parseAbi([
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
]);
/** Emitted in postOp; paymasterMode 1 is ERC-20 (the fee taken in `token`), measured on Base 2026-10-15. */
const paymasterEventsAbi = parseAbi([
  "event UserOperationSponsored(bytes32 indexed userOpHash, address indexed user, uint8 paymasterMode, address token, uint256 tokenAmountPaid, uint256 exchangeRate)",
]);

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const SPOKE_EVENT_NAMES = ["Supply", "Withdraw", "Borrow", "Repay", "LiquidationCall"] as const;
const SPOKE_EVENTS = SPOKE_EVENT_NAMES.map((name) => toEventSelector(getAbiItem({ abi: spokeAbi, name })));
const SAVINGS_SUPPLY = toEventSelector(savingsEventsAbi[0]);
const SAVINGS_WITHDRAW = toEventSelector(savingsEventsAbi[1]);
const SAVINGS_BORROW = toEventSelector(savingsEventsAbi[2]);
const SAVINGS_REPAY = toEventSelector(savingsEventsAbi[3]);
const SAVINGS_LIQUIDATION = toEventSelector(savingsEventsAbi[4]);
const SAVINGS_EVENTS = [SAVINGS_SUPPLY, SAVINGS_WITHDRAW, SAVINGS_BORROW, SAVINGS_REPAY, SAVINGS_LIQUIDATION];
const SPONSORED = toEventSelector(paymasterEventsAbi[0]);
const JOINED = toEventSelector(getAbiItem({ abi: gooseBoardAbi, name: "Joined" }));
const LIQUIDATION = toEventSelector(getAbiItem({ abi: spokeAbi, name: "LiquidationCall" }));
const TOKEN_ADDRESSES = BOARD_TOKENS.map((t) => t.address);

/** Accounts per topic list: public RPCs take a few dozen OR'd topics comfortably. */
const ACCOUNTS_PER_QUERY = 50;
/** Requests in flight at once. */
const CONCURRENCY = 4;
/** A chunk is kept once the chain is this many blocks past it (Base has not reorged this deep). */
const SETTLED = 64n;

type Chunk = { from: bigint; to: bigint };

/** The chunks from `from` to `to`, cut on BOARD_LOG_CHUNK boundaries, oldest first. */
function boardChunks(from: bigint, to: bigint, size = BOARD_LOG_CHUNK): Chunk[] {
  const out: Chunk[] = [];
  for (let lo = from; lo <= to; ) {
    const hi = (lo / size + 1n) * size - 1n;
    out.push({ from: lo, to: hi < to ? hi : to });
    lo = (hi < to ? hi : to) + 1n;
  }
  return out;
}

/**
 * Contract addresses per eth_getLogs request: PublicNode refuses more ("A maximum of 10 addresses is allowed",
 * measured 2026-10-20), and the board tracks more tokens than that.
 */
export const ADDRESSES_PER_QUERY = 10;

/** `addresses` cut into groups PublicNode takes in one request, in order. */
export function addressGroups(addresses: readonly Address[], size = ADDRESSES_PER_QUERY): Address[][] {
  const out: Address[][] = [];
  for (let i = 0; i < addresses.length; i += size) out.push(addresses.slice(i, i + size));
  return out;
}

async function getLogs(
  client: Client,
  address: Address | Address[],
  topics: (Hex | Hex[] | null)[],
  c: Chunk,
): Promise<Log[]> {
  const groups = addressGroups(Array.isArray(address) ? address : [address]);
  const parts = await Promise.all(
    groups.map(
      (group) =>
        client.request({
          method: "eth_getLogs",
          params: [{ address: group, topics, fromBlock: toHex(c.from), toBlock: toHex(c.to) }],
        }) as Promise<RpcLog[]>,
    ),
  );
  return parts.flat().map((l) => formatLog(l));
}

const base = (l: Log) => ({ block: l.blockNumber!, tx: l.transactionHash!, logIndex: l.logIndex! });

/** Decodes the board's logs into records; anything else is dropped. */
export function decodeRecords(logs: readonly Log[]): BoardRecord[] {
  const out: BoardRecord[] = [];
  for (const l of logs) {
    const t0 = l.topics[0];
    if (t0 === TRANSFER && TOKEN_ADDRESSES.some((a) => isAddressEqual(a, l.address))) {
      const [e] = parseEventLogs({ abi: erc20Abi, logs: [l], eventName: "Transfer", strict: true });
      if (e)
        out.push({
          kind: "transfer",
          ...base(l),
          token: l.address,
          from: e.args.from,
          to: e.args.to,
          value: e.args.value,
        });
    } else if (isAddressEqual(l.address, AAVE.SPOKE)) {
      const [e] = parseEventLogs({ abi: spokeAbi, logs: [l], eventName: [...SPOKE_EVENT_NAMES], strict: true });
      if (!e) continue;
      const a = e.args as Record<string, unknown>;
      if (e.eventName === "LiquidationCall") {
        out.push({
          kind: "spoke",
          ...base(l),
          event: "LiquidationCall",
          reserveId: Number(a.debtReserveId as bigint),
          caller: a.liquidator as Address,
          user: a.user as Address,
          amount: a.debtAmountRestored as bigint,
        });
      } else {
        const amount = (a.suppliedAmount ?? a.withdrawnAmount ?? a.drawnAmount ?? a.totalAmountRepaid) as bigint;
        out.push({
          kind: "spoke",
          ...base(l),
          event: e.eventName,
          reserveId: Number(a.reserveId as bigint),
          caller: a.caller as Address,
          user: a.user as Address,
          amount,
        });
      }
    } else if (isAddressEqual(l.address, PROTOCOLS.AAVE_V3_POOL) && t0 && SAVINGS_EVENTS.includes(t0)) {
      const [e] = parseEventLogs({ abi: savingsEventsAbi, logs: [l], strict: true });
      if (!e) continue;
      const b = base(l);
      if (e.eventName === "Supply")
        out.push({
          kind: "savings",
          ...b,
          event: "Supply",
          reserve: e.args.reserve,
          by: e.args.user,
          for: e.args.onBehalfOf,
          amount: e.args.amount,
        });
      else if (e.eventName === "Withdraw")
        out.push({
          kind: "savings",
          ...b,
          event: "Withdraw",
          reserve: e.args.reserve,
          by: e.args.user,
          for: e.args.to,
          amount: e.args.amount,
        });
      else if (e.eventName === "Borrow")
        out.push({
          kind: "savingsCredit",
          ...b,
          event: "Borrow",
          reserve: e.args.reserve,
          debtor: e.args.onBehalfOf,
          by: e.args.user,
          amount: e.args.amount,
        });
      else if (e.eventName === "Repay") {
        out.push({
          kind: "savingsCredit",
          ...b,
          event: "Repay",
          reserve: e.args.reserve,
          debtor: e.args.user,
          by: e.args.repayer,
          amount: e.args.amount,
          aTokens: e.args.useATokens,
        });
      } else {
        out.push({
          kind: "savingsCredit",
          ...b,
          event: "LiquidationCall",
          reserve: e.args.debtAsset,
          debtor: e.args.user,
          by: e.args.liquidator,
          amount: e.args.debtToCover,
          collateral: e.args.collateralAsset,
          aTokens: e.args.receiveAToken,
        });
      }
    } else if (isAddressEqual(l.address, JAW_PAYMASTER) && t0 === SPONSORED) {
      const [e] = parseEventLogs({ abi: paymasterEventsAbi, logs: [l], strict: true });
      if (e && e.args.paymasterMode === 1)
        out.push({ kind: "fee", ...base(l), user: e.args.user, token: e.args.token, amount: e.args.tokenAmountPaid });
    }
  }
  return out;
}

/** The four queries for `accounts` over one chunk. */
async function readChunkLogs(client: Client, accounts: readonly Address[], c: Chunk): Promise<Log[]> {
  const topics = accounts.map((a) => pad(a.toLowerCase() as Address));
  const parts = await Promise.all([
    getLogs(client, [...TOKEN_ADDRESSES], [TRANSFER, topics], c),
    getLogs(client, [...TOKEN_ADDRESSES], [TRANSFER, null, topics], c),
    // topic 3: the spoke's user; V3 Withdraw's `to`; V3 LiquidationCall's user
    getLogs(
      client,
      [AAVE.SPOKE, PROTOCOLS.AAVE_V3_POOL],
      [[...SPOKE_EVENTS, SAVINGS_WITHDRAW, SAVINGS_LIQUIDATION], null, null, topics],
      c,
    ),
    // topic 2: V3 Supply's and Borrow's onBehalfOf; V3 Withdraw's and Repay's user; the paymaster's user
    getLogs(
      client,
      [PROTOCOLS.AAVE_V3_POOL, JAW_PAYMASTER],
      [[SAVINGS_SUPPLY, SAVINGS_WITHDRAW, SAVINGS_BORROW, SAVINGS_REPAY, SPONSORED], null, topics],
      c,
    ),
  ]);
  return parts.flat();
}

/* ── the chunk cache ───────────────────────────────────────────────── */

type Stored = { v: 2; records: unknown[] };
const memory = new Map<string, unknown[]>();
// v2: chunks hold Aave V3 credit events too, so v1's are read again.
const STORAGE_PREFIX = "gg.board.v2:";

// Records hold bigints; storage holds JSON.
const toJson = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
const fromJson = (r: unknown): unknown =>
  JSON.parse(JSON.stringify(r), (_k, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function cacheKey(board: Address, accounts: readonly Address[], c: Chunk) {
  return `${board.toLowerCase()}:${c.from}-${c.to}:${hash(
    accounts
      .map((a) => a.toLowerCase())
      .sort()
      .join(","),
  )}`;
}

function cached<T = BoardRecord>(key: string): T[] | undefined {
  const hit = memory.get(key);
  if (hit) return hit as T[];
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as Stored;
    if (stored.v !== 2) return undefined;
    const records = stored.records.map(fromJson);
    memory.set(key, records);
    return records as T[];
  } catch {
    return undefined;
  }
}

function keep<T = BoardRecord>(key: string, records: T[]) {
  memory.set(key, records);
  try {
    globalThis.localStorage?.setItem(
      STORAGE_PREFIX + key,
      JSON.stringify({ v: 2, records: records.map(toJson) } satisfies Stored),
    );
  } catch {
    /* storage full or blocked: memory still has it */
  }
}

/** Runs `jobs` with at most CONCURRENCY in flight; the first failure fails the lot. */
async function pool<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

/**
 * Every record about `members` from the block after each one's join up to `head`. Each chunk asks only about members
 * who had joined before it ended. Throws if any request fails: the board is all or nothing, never partial.
 */
export async function readBoardRecords(
  client: Client,
  board: Address,
  members: readonly { account: Address; joinedAt: bigint }[],
  head: bigint,
): Promise<BoardRecord[]> {
  if (!members.length) return [];
  const start = members.reduce((m, x) => (x.joinedAt < m ? x.joinedAt : m), members[0].joinedAt) + 1n;
  if (start > head) return [];
  const jobs: (() => Promise<BoardRecord[]>)[] = [];
  for (const c of boardChunks(start, head)) {
    const accounts = members.filter((m) => m.joinedAt < c.to).map((m) => m.account);
    for (let i = 0; i < accounts.length; i += ACCOUNTS_PER_QUERY) {
      const group = accounts.slice(i, i + ACCOUNTS_PER_QUERY);
      const settled = c.to + SETTLED <= head;
      const key = cacheKey(board, group, c);
      jobs.push(async () => {
        const hit = settled ? cached(key) : undefined;
        if (hit) return hit;
        const records = decodeRecords(await readChunkLogs(client, group, c));
        if (settled) keep(key, records);
        return records;
      });
    }
  }
  return (await pool(jobs)).flat();
}

/* ── the Wall: who joined and whose stock was sold (lib/board/wall.ts) ── */

/**
 * GooseBoard's Joined events and Aave V4's LiquidationCall, from logs; anything else is dropped. A sale names the stock
 * sold (`collateralReserveId`); whether it counts is lib/board/wall.ts's call.
 */
export function decodeWallLogs(logs: readonly Log[], board: Address): { joins: WallJoin[]; sales: WallSale[] } {
  const joins: WallJoin[] = [];
  const sales: WallSale[] = [];
  for (const l of logs) {
    if (isAddressEqual(l.address, board) && l.topics[0] === JOINED) {
      const [e] = parseEventLogs({ abi: gooseBoardAbi, logs: [l], eventName: "Joined", strict: true });
      if (e) joins.push({ account: e.args.account, block: l.blockNumber! });
    } else if (isAddressEqual(l.address, AAVE.SPOKE) && l.topics[0] === LIQUIDATION) {
      const [e] = parseEventLogs({ abi: spokeAbi, logs: [l], eventName: "LiquidationCall", strict: true });
      if (e)
        sales.push({
          account: e.args.user,
          block: l.blockNumber!,
          tx: l.transactionHash!,
          logIndex: l.logIndex!,
          stockReserveId: Number(e.args.collateralReserveId),
        });
    }
  }
  return { joins, sales };
}

/**
 * Every join of `board` and every sale on Aave V4's spoke after block `from` up to `head`, one request per 10,000-block
 * chunk. Sales are rare, so they are read for the whole spoke and matched to members after (lib/board/wall.ts), which
 * also finds members who left. A settled chunk is read once and kept. Throws if any request fails.
 */
export async function readWallRecords(
  client: Client,
  board: Address,
  from: bigint,
  head: bigint,
): Promise<{ joins: WallJoin[]; sales: WallSale[] }> {
  if (from >= head) return { joins: [], sales: [] };
  type Rec = { joins: WallJoin[]; sales: WallSale[] };
  const jobs = boardChunks(from + 1n, head).map((c) => async (): Promise<Rec> => {
    const settled = c.to + SETTLED <= head;
    const key = `${board.toLowerCase()}:wall:${c.from}-${c.to}`;
    const hit = settled ? cached<Rec>(key) : undefined;
    if (hit) return hit[0];
    const rec = decodeWallLogs(await getLogs(client, [board, AAVE.SPOKE], [[JOINED, LIQUIDATION]], c), board);
    if (settled) keep(key, [rec]);
    return rec;
  });
  const parts = await pool(jobs);
  return { joins: parts.flatMap((p) => p.joins), sales: parts.flatMap((p) => p.sales) };
}

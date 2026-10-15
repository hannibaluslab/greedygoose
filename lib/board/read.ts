import type { Address, Client } from "viem";
import { getBlockNumber, readContract } from "viem/actions";
import { gooseBoardAbi } from "./abi";
import { memberFlows, peakCredit, type FlowRules, type Move } from "./flows";
import { readInside } from "./inside";
import { readBoardRecords } from "./logs";
import { rankRows, returnSinceJoining } from "./score";
import { tokenInfo } from "./tokens";
import { readHoldings, readPrices, stockUsd6, worth6, type Holdings, type Prices } from "./worth";
import { GUARDIAN } from "@/lib/guardian/config";
import { USDC } from "@/lib/tokens/registry";

export type Member = { account: Address; joinedAt: bigint };

/** One row of the board: percent only. `pct` is null and `rank` is null for a member who isn't ranked yet. */
export type BoardRow = Member & { pct: number | null; rank: number | null };

export type Board = { head: bigint; rows: BoardRow[] };

/** Members per page() call. */
const PAGE = 500n;

/** Everyone on the board now, in the order they first joined, as of `blockNumber`. */
export async function readMembers(client: Client, board: Address, blockNumber: bigint): Promise<Member[]> {
  const count = await readContract(client, { address: board, abi: gooseBoardAbi, functionName: "memberCount", blockNumber });
  const out: Member[] = [];
  for (let start = 0n; start < count; start += PAGE) {
    const [accounts, onBoard, joinedAt] = await readContract(client, {
      address: board,
      abi: gooseBoardAbi,
      functionName: "page",
      args: [start, PAGE],
      blockNumber,
    });
    accounts.forEach((account, i) => {
      if (onBoard[i]) out.push({ account, joinedAt: joinedAt[i] });
    });
  }
  return out;
}

/* Past state never changes: prices at a block and holdings at a join block are kept for the session. */
const pricesAt = new Map<bigint, Promise<Prices>>();
const joinHoldings = new Map<string, Promise<Holdings>>();
let insideOnce: Promise<Address[]> | undefined;

function prices(client: Client, block: bigint): Promise<Prices> {
  let p = pricesAt.get(block);
  if (!p) {
    p = readPrices(client, block);
    p.catch(() => pricesAt.delete(block));
    pricesAt.set(block, p);
  }
  return p;
}

async function holdingsAtJoin(client: Client, members: readonly Member[]): Promise<Holdings[]> {
  // Members who joined in the same block share one read.
  const missing = new Map<bigint, Address[]>();
  for (const m of members) {
    if (joinHoldings.has(`${m.account.toLowerCase()}@${m.joinedAt}`)) continue;
    missing.set(m.joinedAt, [...(missing.get(m.joinedAt) ?? []), m.account]);
  }
  for (const [block, accounts] of missing) {
    const read = readHoldings(client, accounts, block);
    accounts.forEach((a, i) => {
      const key = `${a.toLowerCase()}@${block}`;
      const one = read.then((h) => h[i]);
      one.catch(() => joinHoldings.delete(key));
      joinHoldings.set(key, one);
    });
  }
  return Promise.all(members.map((m) => joinHoldings.get(`${m.account.toLowerCase()}@${m.joinedAt}`)!));
}

const dollars = (usd6: bigint) => Number(usd6) / 10 ** USDC.decimals;

/**
 * The whole board, as of the last block both clients have: members from GooseBoard, their logs since joining
 * (`logs`, an RPC that serves eth_getLogs), what they held when they joined and now (`state`, which must serve past
 * state), and Aave's price for every stock that moved in or out when it moved. Throws when any read fails, so the
 * screen says it couldn't load the board rather than showing rows that might be wrong.
 */
export async function readBoard(p: { state: Client; logs: Client; board: Address }): Promise<Board> {
  const [stateHead, logsHead] = await Promise.all([getBlockNumber(p.state, { cacheTime: 0 }), getBlockNumber(p.logs, { cacheTime: 0 })]);
  const head = stateHead < logsHead ? stateHead : logsHead;
  // A member whose join block is past what both nodes have shows up on the next read.
  const members = (await readMembers(p.state, p.board, head)).filter((m) => m.joinedAt <= head);
  if (!members.length) return { head, rows: [] };

  insideOnce ??= readInside(p.state).catch((e) => {
    insideOnce = undefined;
    throw e;
  });
  const [inside, records, atJoin, now, pricesNow] = await Promise.all([
    insideOnce,
    readBoardRecords(p.logs, p.board, members, head),
    holdingsAtJoin(p.state, members),
    readHoldings(p.state, members.map((m) => m.account), head),
    prices(p.state, head),
  ]);
  const rules: FlowRules = {
    usdc: USDC.address,
    ausdc: GUARDIAN.AUSDC,
    token: tokenInfo,
    inside: (a) => inside.some((b) => b.toLowerCase() === a.toLowerCase()),
  };

  const flows = members.map((m) => memberFlows(m.account, m.joinedAt, records, rules));
  // Stocks that moved in or out are valued at Aave's price in their block; join blocks need their prices too.
  const blocks = new Set<bigint>(members.map((m) => m.joinedAt));
  for (const f of flows) for (const mv of f.moves) if ("stock" in mv) blocks.add(mv.block);
  const priceByBlock = new Map<bigint, Prices>(await Promise.all([...blocks].map(async (b) => [b, await prices(p.state, b)] as const)));
  const value = (mv: Move) => ("usd6" in mv ? mv.usd6 : stockUsd6(mv.stock.raw, priceByBlock.get(mv.block)![mv.stock.reserveId]));

  const rows = members.map((m, i) => {
    const { moves, credit } = flows[i];
    const sum = (dir: "in" | "out") => moves.filter((mv) => mv.dir === dir).reduce((s, mv) => s + value(mv), 0n);
    const score = returnSinceJoining({
      worthAtJoin: dollars(worth6(atJoin[i], priceByBlock.get(m.joinedAt)!)),
      worthNow: dollars(worth6(now[i], pricesNow)),
      putIn: dollars(sum("in")),
      takenOut: dollars(sum("out")),
      peakCredit: dollars(peakCredit(atJoin[i].debt6, credit, now[i].debt6)),
    });
    return { ...m, pct: score.pct };
  });
  return { head, rows: rankRows(rows) };
}

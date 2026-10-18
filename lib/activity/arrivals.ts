import {
  BaseError,
  HttpRequestError,
  LimitExceededRpcError,
  encodeEventTopics,
  erc20Abi,
  formatLog,
  hexToBigInt,
  pad,
  parseUnits,
  toHex,
  type Address,
  type Client,
  type Hex,
  type Log,
  type RpcLog,
} from "viem";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { decodeActivity, type ActivityItem } from "./decode";

/*
 * Money someone else sends: JAW's call history lists only the account's own batches, and the executor's Saves only
 * stand in for what arrived, so the Cash sheet reads USDC's own Transfer logs to the account (no indexer, D12).
 */

const [TRANSFER] = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" });

/**
 * The first block anything in GreedyGoose could have happened in: the Aave V4 Equities spoke's deployment (Base block
 * 51,478,830, 2026-09-18, measured with eth_getCode). Activity reads arrivals no further back.
 */
export const APP_START_BLOCK = 51_478_830n;

/**
 * Whether arrivals can be read at all: they need an RPC that answers getLogs, and Base's public one refuses them (HTTP
 * 429 on every request, measured 2026-10-18). Until NEXT_PUBLIC_BASE_RPC_URL names one, the Cash sheet and Activity
 * read none and say nothing is missing.
 */
export const ARRIVALS_ON = !!process.env.NEXT_PUBLIC_BASE_RPC_URL;

/** The smallest arrival shown: under a cent is dust, and address-poisoning sends are often less. */
export const MIN_ARRIVAL_USD = 0.01;

/**
 * JSON-RPC codes RPCs send for "too many requests": 429 in the body, the standard limit exceeded (-32005), QuickNode's
 * -32007, and Base's public RPC's -32011 ("request limit reached", measured 2026-10-15 on mainnet.base.org: an HTTP
 * 429 whose body viem reads as that RPC error).
 */
const RATE_CODES = new Set([429, LimitExceededRpcError.code, -32007, -32011]);

/**
 * The RPC said no to the rate: asking again at once only adds to the load, so these reads wait for the next block
 * instead of retrying.
 */
export function rateLimited(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    !!e.walk(
      (x) =>
        (x instanceof HttpRequestError && x.status === 429) ||
        (typeof x === "object" && x !== null && "code" in x && typeof x.code === "number" && RATE_CODES.has(x.code)),
    )
  );
}

/** USDC and the stocks: what Activity shows arriving (the Cash sheet reads USDC alone). */
export const RECEIVED_TOKENS: readonly Address[] = [USDC.address, ...EQUITIES.map((e) => e.address)];

/**
 * Transfer logs to `account` in one range, from `tokens`' own contracts only (USDC's by default), so no other token can
 * pose as one of them.
 */
export async function readArrivalLogs(
  client: Client,
  q: { account: Address; from: bigint; to: bigint; tokens?: readonly Address[] },
): Promise<Log[]> {
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: q.tokens ? [...q.tokens] : USDC.address,
        topics: [TRANSFER, null, pad(q.account.toLowerCase() as Address)],
        fromBlock: toHex(q.from),
        toBlock: toHex(q.to),
      },
    ],
  })) as RpcLog[];
  return logs.map((l) => formatLog(l));
}

/** MIN_ARRIVAL_USD in USDC units. */
const MIN_ARRIVAL_RAW = parseUnits(String(MIN_ARRIVAL_USD), USDC.decimals);

/** A Transfer log's amount (its one unindexed word). */
const valueOf = (l: Log) => (l.data && l.data !== "0x" ? hexToBigInt(l.data) : 0n);

/**
 * The transactions those logs came from, once each, newest first, leaving out those that brought under a cent in all
 * (dust, often address poisoning): arrivalsOf would show nothing for them, so their receipts aren't fetched.
 */
export function arrivalTxs(logs: readonly Log[]): { hash: Hex; blockNumber: bigint }[] {
  const seen = new Map<Hex, { blockNumber: bigint; raw: bigint; stock: boolean }>();
  for (const l of logs) {
    if (!l.transactionHash || l.blockNumber === null) continue;
    // A stock's shares count at any size: only its own contract's logs are read, so none of them is a fake.
    const usdc = l.address.toLowerCase() === USDC.address.toLowerCase();
    const raw = usdc ? valueOf(l) : 0n;
    const stock = !usdc && valueOf(l) > 0n;
    const tx = seen.get(l.transactionHash);
    if (tx) {
      tx.raw += raw;
      tx.stock ||= stock;
    } else seen.set(l.transactionHash, { blockNumber: l.blockNumber, raw, stock });
  }
  return [...seen]
    .filter(([, t]) => t.raw >= MIN_ARRIVAL_RAW || t.stock)
    .map(([hash, t]) => ({ hash, blockNumber: t.blockNumber }))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
}

/**
 * What a transaction the account's own history doesn't list brought it: its USDC receives of a cent or more (and, for
 * Activity, `withStocks`, the stocks it was sent), and nothing else. Anything else decoded from it (credit taken, a sale, a conversion, savings coming back) is a move whose
 * other half this read never sees (where the money went next), so it is left to the rows that do see it.
 */
export function arrivalsOf(receiptLogs: Log[], account: Address, withStocks = false): ActivityItem[] {
  // The account's own batch (its UserOperationEvent names it the sender) is its own move, never money sent to it.
  if (receiptLogs.some((l) => l.topics[0] === USER_OP_EVENT && sameAddress(l.topics[2], account))) return [];
  return decodeActivity(receiptLogs, account).filter(
    (i) =>
      i.kind === "receive" &&
      (i.symbol === USDC.symbol
        ? i.amount >= MIN_ARRIVAL_USD
        : withStocks && EQUITIES.some((e) => e.symbol === i.symbol)),
  );
}

/** EntryPoint's UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, …). */
const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const sameAddress = (topic: Hex | undefined, a: Address) =>
  !!topic && topic.length === 66 && `0x${topic.slice(26)}`.toLowerCase() === a.toLowerCase();

/** The block ranges, settled, already scanned for an account's arrivals: one stretch, and what it found. */
export type ScannedArrivals = { lo: bigint; hi: bigint; txs: { hash: Hex; blockNumber: bigint }[] };

/**
 * What is left to scan to cover `from`..`to` (settled blocks) given what was scanned before: the blocks above it, and
 * the part below it, so one stretch keeps growing and nothing is read twice.
 */
export function rangesToScan(from: bigint, to: bigint, kept: ScannedArrivals | null): { from: bigint; to: bigint }[] {
  if (to < from) return [];
  if (!kept) return [{ from, to }];
  const out: { from: bigint; to: bigint }[] = [];
  // From the kept stretch's top, even past `from`: the stretch stays one, with no gap it would claim to have read.
  if (to > kept.hi) out.push({ from: kept.hi + 1n, to });
  if (from < kept.lo) out.push({ from, to: kept.lo - 1n < to ? kept.lo - 1n : to });
  return out;
}

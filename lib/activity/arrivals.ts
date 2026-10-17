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
import { USDC } from "@/lib/tokens/registry";
import { decodeActivity, type ActivityItem } from "./decode";

/*
 * Money someone else sends: JAW's call history lists only the account's own batches, and the executor's Saves only
 * stand in for what arrived, so the Cash sheet reads USDC's own Transfer logs to the account (no indexer, D12).
 */

const [TRANSFER] = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" });

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

/** USDC Transfer logs to `account` in one range (USDC's contract only, so no other token can pose as it). */
export async function readArrivalLogs(
  client: Client,
  q: { account: Address; from: bigint; to: bigint },
): Promise<Log[]> {
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: USDC.address,
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
  const seen = new Map<Hex, { blockNumber: bigint; raw: bigint }>();
  for (const l of logs) {
    if (!l.transactionHash || l.blockNumber === null) continue;
    const tx = seen.get(l.transactionHash);
    if (tx) tx.raw += valueOf(l);
    else seen.set(l.transactionHash, { blockNumber: l.blockNumber, raw: valueOf(l) });
  }
  return [...seen]
    .filter(([, t]) => t.raw >= MIN_ARRIVAL_RAW)
    .map(([hash, t]) => ({ hash, blockNumber: t.blockNumber }))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
}

/**
 * What a transaction the account's own history doesn't list brought it: its USDC receives of a cent or more, and
 * nothing else. Anything else decoded from it (credit taken, a sale, a conversion, savings coming back) is a move whose
 * other half this read never sees (where the money went next), so it is left to the rows that do see it.
 */
export function arrivalsOf(receiptLogs: Log[], account: Address): ActivityItem[] {
  return decodeActivity(receiptLogs, account).filter(
    (i) => i.kind === "receive" && i.symbol === USDC.symbol && i.amount >= MIN_ARRIVAL_USD,
  );
}

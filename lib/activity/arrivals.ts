import { encodeEventTopics, erc20Abi, formatLog, pad, toHex, type Address, type Client, type Hex, type Log, type RpcLog } from "viem";
import { USDC } from "@/lib/tokens/registry";
import { decodeActivity, type ActivityItem } from "./decode";

/*
 * Money someone else sends: JAW's call history lists only the account's own batches, and the executor's Saves only
 * stand in for what arrived, so the Cash sheet reads USDC's own Transfer logs to the account (no indexer, D12).
 */

const [TRANSFER] = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" });

/** The smallest arrival shown: under a cent is dust, and address-poisoning sends are often less. */
export const MIN_ARRIVAL_USD = 0.01;

/** USDC Transfer logs to `account` in one range (USDC's contract only, so no other token can pose as it). */
export async function readArrivalLogs(client: Client, q: { account: Address; from: bigint; to: bigint }): Promise<Log[]> {
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [{ address: USDC.address, topics: [TRANSFER, null, pad(q.account.toLowerCase() as Address)], fromBlock: toHex(q.from), toBlock: toHex(q.to) }],
  })) as RpcLog[];
  return logs.map((l) => formatLog(l));
}

/** The transactions those logs came from, once each, newest first. */
export function arrivalTxs(logs: readonly Log[]): { hash: Hex; blockNumber: bigint }[] {
  const seen = new Map<Hex, bigint>();
  for (const l of logs) if (l.transactionHash && l.blockNumber !== null && !seen.has(l.transactionHash)) seen.set(l.transactionHash, l.blockNumber);
  return [...seen].map(([hash, blockNumber]) => ({ hash, blockNumber })).sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
}

/**
 * What a transaction the account's own history doesn't list brought it: its USDC receives of a cent or more, and
 * nothing else. Anything else decoded from it (credit taken, a sale, a conversion, savings coming back) is a move whose
 * other half this read never sees (where the money went next), so it is left to the rows that do see it.
 */
export function arrivalsOf(receiptLogs: Log[], account: Address): ActivityItem[] {
  return decodeActivity(receiptLogs, account).filter((i) => i.kind === "receive" && i.symbol === USDC.symbol && i.amount >= MIN_ARRIVAL_USD);
}

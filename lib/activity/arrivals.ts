import { parseUnits, type Address, type Hex, type Log } from "viem";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import type { TransferIn } from "./alchemy";
import { decodeActivity, type ActivityItem } from "./decode";

/*
 * Money someone else sends: JAW's call history lists only the account's own batches, and the executor's Saves only
 * stand in for what arrived, so Activity and the Cash sheet read the USDC and stock transfers to the account from
 * Alchemy's Transfers API (lib/activity/alchemy.ts; no indexer of ours, D12) and decode each one's receipt.
 */

/**
 * The first block anything in GreedyGoo could have happened in: the Aave V4 Equities spoke's deployment (Base block
 * 51,478,830, 2026-09-18, measured with eth_getCode). Activity reads arrivals no further back.
 */
export const APP_START_BLOCK = 51_478_830n;

/** The smallest arrival shown: under a cent is dust, and address-poisoning sends are often less. */
export const MIN_ARRIVAL_USD = 0.01;

/** USDC and the stocks: what Activity shows arriving (the Cash sheet reads USDC alone). */
export const RECEIVED_TOKENS: readonly Address[] = [USDC.address, ...EQUITIES.map((e) => e.address)];

/** MIN_ARRIVAL_USD in USDC units. */
const MIN_ARRIVAL_RAW = parseUnits(String(MIN_ARRIVAL_USD), USDC.decimals);

/**
 * The transactions worth a receipt, newest first: those that brought a cent or more of USDC in all, or any stock (only
 * the stocks' own contracts are read, so none is a fake). Under a cent is dust, often address poisoning: arrivalsOf
 * would show nothing for it, so its receipt isn't fetched.
 */
export function arrivalTxs(transfers: readonly TransferIn[]): TransferIn[] {
  return transfers
    .filter((t) => t.usdcRaw >= MIN_ARRIVAL_RAW || t.stock)
    .sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
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

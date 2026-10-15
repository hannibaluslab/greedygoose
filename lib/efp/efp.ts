/**
 * Contacts on-chain: the Ethereum Follow Protocol (EFP) follow list on Base, the booth app's `src/lib/efp.ts` ported
 * as-is (it came from NYM's `src/lib/efp/`, where every byte format was verified against the deployed contracts, and
 * contracts/test/GooseBoardFork.t.sol checks it again on a Base fork). A contact is a follow record in a list the
 * user's own account owns, written by that account, readable by anyone.
 *
 * - EFP's write contracts are on Base mainnet only, which is GreedyGoose's chain, so the booth's `EFP_AVAILABLE`
 *   switch is always on here and is dropped.
 * - A first contact mints the list first: `easyMint` and the follows go in one batch, one JAW sheet either way.
 *
 * Pure: no network, no React.
 */
import { encodeFunctionData, numberToHex, type Address, type Hex } from "viem";
import { CHAIN_ID } from "@/lib/chain";

/** The only chain EFP writes go to. */
export const EFP_CHAIN_ID = 8453;
if (CHAIN_ID !== EFP_CHAIN_ID) throw new Error("EFP lives on Base mainnet only");

export const EFP_ACCOUNT_METADATA = "0x5289fE5daBC021D02FDDf23d4a4DF96F4E0F17EF" as const;
export const EFP_LIST_REGISTRY = "0x0E688f5DCa4a0a4729946ACbC44C792341714e08" as const;
export const EFP_LIST_RECORDS = "0x41Aa48Ef3c0446b46a5b1cc6337FF3d3716E2A33" as const;
export const EFP_LIST_MINTER = "0xDb17Bfc64aBf7B7F080a49f0Bbbf799dDbb48Ce5" as const;

/** The most people one "Add" writes: the booth's server took 25 a call (`BATCH_MAX`). */
export const MAX_LIST_OPS = 25;

export const efpListMinterAbi = [
  { type: "function", name: "easyMint", stateMutability: "payable", inputs: [{ name: "listStorageLocation", type: "bytes" }], outputs: [] },
] as const;

export const efpAccountMetadataAbi = [
  {
    type: "function",
    name: "getValue",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }, { name: "key", type: "string" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

export const efpListRegistryAbi = [
  {
    type: "function",
    name: "getListStorageLocation",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

export const efpListRecordsAbi = [
  {
    type: "function",
    name: "applyListOps",
    stateMutability: "nonpayable",
    inputs: [{ name: "slot", type: "uint256" }, { name: "ops", type: "bytes[]" }],
    outputs: [],
  },
  { type: "function", name: "getListOpCount", stateMutability: "view", inputs: [{ name: "slot", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getAllListOps", stateMutability: "view", inputs: [{ name: "slot", type: "uint256" }], outputs: [{ name: "", type: "bytes[]" }] },
  {
    type: "function",
    name: "getListOpsInRange",
    stateMutability: "view",
    inputs: [{ name: "slot", type: "uint256" }, { name: "start", type: "uint256" }, { name: "end", type: "uint256" }],
    outputs: [{ name: "", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "getMetadataValue",
    stateMutability: "view",
    inputs: [{ name: "slot", type: "uint256" }, { name: "key", type: "string" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

const strip = (hex: string) => (hex.startsWith("0x") ? hex.slice(2) : hex);

/* ── encoding ──────────────────────────────────────────────────────── */

/** `0x01 | opcode | 0x01 | 0x01 | address`: one EFP list op. */
export function encodeListOp(opcode: "add" | "remove", target: Address): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error(`Not an address: ${target}`);
  return `0x01${opcode === "add" ? "01" : "02"}0101${strip(target).toLowerCase()}` as Hex;
}

/** The 86-byte location `easyMint` takes: version, type, chain, records, slot. */
export function encodeListStorageLocation(slot: bigint): Hex {
  const chainHex = strip(numberToHex(BigInt(EFP_CHAIN_ID), { size: 32 }));
  const slotHex = strip(numberToHex(slot, { size: 32 }));
  return `0x0101${chainHex}${strip(EFP_LIST_RECORDS).toLowerCase()}${slotHex}` as Hex;
}

/** Slots are claimed first-come across 2^256, so a random one is safe. */
export function randomListSlot(): bigint {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

export type EfpCall = { to: Address; data: Hex; value: bigint };

const applyOps = (slot: bigint, ops: Hex[]): EfpCall => ({
  to: EFP_LIST_RECORDS,
  data: encodeFunctionData({ abi: efpListRecordsAbi, functionName: "applyListOps", args: [slot, ops] }),
  value: 0n,
});

/**
 * Add one person or several, in a single call either way. `applyListOps` takes an array, so N follows are one op
 * list and one signature, which is why the board lets you tick several before adding. Without a list yet,
 * `easyMint` goes first in the same batch: one approval mints the list, makes it primary, and writes every follow.
 */
export function buildFollowCalls(targets: Address[], hasList: boolean, slot: bigint): EfpCall[] {
  if (!targets.length) throw new Error("Nobody to follow");
  const apply = applyOps(slot, targets.map((t) => encodeListOp("add", t)));
  if (hasList) return [apply];
  return [
    {
      to: EFP_LIST_MINTER,
      data: encodeFunctionData({ abi: efpListMinterAbi, functionName: "easyMint", args: [encodeListStorageLocation(slot)] }),
      value: 0n,
    },
    apply,
  ];
}

/**
 * Remove people from the list: EFP's remove op, on-chain. The booth only deleted its own database row and left the
 * follow on Base; GreedyGoose has no database (D12), so removing writes the op.
 */
export function buildUnfollowCalls(targets: Address[], slot: bigint): EfpCall[] {
  if (!targets.length) throw new Error("Nobody to remove");
  return [applyOps(slot, targets.map((t) => encodeListOp("remove", t)))];
}

/* ── decoding, for reading a list back ─────────────────────────────── */

/** `easyMint` stores exactly 32 bytes. Anything else means no list. */
export function decodePrimaryListId(value: Hex | undefined): bigint | null {
  if (!value) return null;
  const hex = strip(value);
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return BigInt(`0x${hex}`);
}

export function decodeListStorageLocation(value: Hex | undefined): { chainId: bigint; records: Address; slot: bigint } | null {
  if (!value) return null;
  const hex = strip(value);
  if (hex.length !== 172) return null;
  if (hex.slice(0, 4) !== "0101") return null;
  return {
    chainId: BigInt(`0x${hex.slice(4, 68)}`),
    records: `0x${hex.slice(68, 108)}` as Address,
    slot: BigInt(`0x${hex.slice(108, 172)}`),
  };
}

/** Unknown versions and opcodes are skipped rather than guessed at. */
export function decodeListOp(op: Hex): { kind: "add" | "remove"; address: Address } | null {
  const hex = strip(op);
  if (hex.length !== 48) return null;
  if (parseInt(hex.slice(0, 2), 16) !== 1) return null;
  const opcode = parseInt(hex.slice(2, 4), 16);
  if (parseInt(hex.slice(4, 6), 16) !== 1 || parseInt(hex.slice(6, 8), 16) !== 1) return null;
  if (opcode !== 1 && opcode !== 2) return null;
  const addr = hex.slice(8, 48);
  if (!/^[0-9a-fA-F]{40}$/.test(addr)) return null;
  return { kind: opcode === 1 ? "add" : "remove", address: `0x${addr.toLowerCase()}` as Address };
}

/** The list is an op log; who you follow now is the log replayed in order. */
export function replayListOps(ops: readonly Hex[]): Address[] {
  const present = new Set<Address>();
  for (const raw of ops) {
    const op = decodeListOp(raw);
    if (!op) continue;
    if (op.kind === "add") present.add(op.address);
    else present.delete(op.address);
  }
  return [...present].reverse();
}

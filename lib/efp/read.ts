/**
 * Reading an account's EFP list off Base, the booth's `src/lib/efp-chain.ts` with the client passed in: GreedyGoose
 * has no server (D12), so the browser reads its own list. No indexer: the list registry hands back a storage
 * location, the records contract hands back the raw op log, and the current follow set is that log replayed.
 */
import type { Address, Client, Hex } from "viem";
import { readContract } from "viem/actions";
import {
  decodeListStorageLocation,
  decodePrimaryListId,
  efpAccountMetadataAbi,
  efpListRecordsAbi,
  efpListRegistryAbi,
  EFP_ACCOUNT_METADATA,
  EFP_CHAIN_ID,
  EFP_LIST_RECORDS,
  EFP_LIST_REGISTRY,
  replayListOps,
} from "./efp";

export type Following = {
  /** Who they follow now, newest first, lowercase. Empty when they have no list. */
  addresses: Address[];
  /** Whether a list exists: the screen needs this to know if a mint is due. */
  hasList: boolean;
  /** The slot to write to. Null when there is no list yet, or one this app can't write to. */
  slot: bigint | null;
};

const NONE: Following = { addresses: [], hasList: false, slot: null };

/** Ops are 24 bytes; this many per call stays well inside a public RPC's limits. */
const PAGE = 5_000n;

export async function fetchFollowing(client: Client, address: Address): Promise<Following> {
  const primary = (await readContract(client, {
    address: EFP_ACCOUNT_METADATA,
    abi: efpAccountMetadataAbi,
    functionName: "getValue",
    args: [address, "primary-list"],
  })) as Hex;
  const tokenId = decodePrimaryListId(primary);
  if (tokenId === null) return NONE;

  const location = decodeListStorageLocation(
    (await readContract(client, {
      address: EFP_LIST_REGISTRY,
      abi: efpListRegistryAbi,
      functionName: "getListStorageLocation",
      args: [tokenId],
    })) as Hex,
  );
  // A list can point anywhere (another chain, another records contract). One that doesn't live in the records
  // contract we read is not a list we can show or write, and guessing would be worse than saying nothing.
  if (
    !location ||
    location.chainId !== BigInt(EFP_CHAIN_ID) ||
    location.records.toLowerCase() !== EFP_LIST_RECORDS.toLowerCase()
  ) {
    return { addresses: [], hasList: true, slot: null };
  }

  // A list NFT can be transferred. Its "user" metadata says who it is about, so a list that changed hands must not
  // surface as this account's contacts.
  const userBytes = (await readContract(client, {
    address: EFP_LIST_RECORDS,
    abi: efpListRecordsAbi,
    functionName: "getMetadataValue",
    args: [location.slot, "user"],
  })) as Hex;
  const user = userBytes.replace(/^0x/, "").toLowerCase();
  if (user.length > 0 && user !== address.slice(2).toLowerCase()) return NONE;

  const count = await readContract(client, {
    address: EFP_LIST_RECORDS,
    abi: efpListRecordsAbi,
    functionName: "getListOpCount",
    args: [location.slot],
  });

  let ops: Hex[] = [];
  if (count <= PAGE) {
    ops = [
      ...(await readContract(client, {
        address: EFP_LIST_RECORDS,
        abi: efpListRecordsAbi,
        functionName: "getAllListOps",
        args: [location.slot],
      })),
    ];
  } else {
    // `end` is exclusive, verified against the deployed contract.
    for (let start = 0n; start < count; start += PAGE) {
      const end = start + PAGE > count ? count : start + PAGE;
      ops.push(
        ...(await readContract(client, {
          address: EFP_LIST_RECORDS,
          abi: efpListRecordsAbi,
          functionName: "getListOpsInRange",
          args: [location.slot, start, end],
        })),
      );
    }
  }

  return { addresses: replayListOps(ops), hasList: true, slot: location.slot };
}

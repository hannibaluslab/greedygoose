import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, numberToHex, type Address, type Hex } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import { addContactsCalls, CONTACTS_STOP, removeContactCalls } from "@/lib/efp/contacts";
import {
  buildFollowCalls,
  buildUnfollowCalls,
  decodeListOp,
  decodeListStorageLocation,
  decodePrimaryListId,
  efpAccountMetadataAbi,
  efpListMinterAbi,
  efpListRecordsAbi,
  encodeListOp,
  encodeListStorageLocation,
  EFP_ACCOUNT_METADATA,
  EFP_LIST_MINTER,
  EFP_LIST_RECORDS,
  EFP_LIST_REGISTRY,
  MAX_LIST_OPS,
  replayListOps,
} from "@/lib/efp/efp";
import type { Following } from "@/lib/efp/read";

const user = "0x000000000000000000000000000000000000a11c" as Address;
const kit = "0x000000000000000000000000000000000000B0b0" as Address;
const leo = "0x0000000000000000000000000000000000001e00" as Address;
const SLOT = 42n;
const none: Following = { addresses: [], hasList: false, slot: null };
const mine: Following = { addresses: [kit.toLowerCase() as Address], hasList: true, slot: SLOT };

describe("EFP encoding (the booth's, unchanged)", () => {
  it("encodes one op per person: version, add/remove, record version, address record, address", () => {
    expect(encodeListOp("add", kit)).toBe(`0x01010101${kit.slice(2).toLowerCase()}`);
    expect(decodeListOp(encodeListOp("remove", kit))).toEqual({ kind: "remove", address: kit.toLowerCase() });
    expect(decodeListOp("0x010301010000000000000000000000000000000000000000")).toBeNull(); // a tag op
    expect(() => encodeListOp("add", "0x1234" as Address)).toThrow();
  });

  it("round-trips the 86-byte list location on Base", () => {
    const loc = encodeListStorageLocation(SLOT);
    expect((loc.length - 2) / 2).toBe(86);
    expect(decodeListStorageLocation(loc)).toEqual({
      chainId: 8453n,
      records: EFP_LIST_RECORDS.toLowerCase(),
      slot: SLOT,
    });
    expect(decodePrimaryListId(numberToHex(7n, { size: 32 }))).toBe(7n);
    expect(decodePrimaryListId("0x")).toBeNull();
  });

  it("replays the op log: an add then a remove leaves nobody", () => {
    expect(replayListOps([encodeListOp("add", kit), encodeListOp("add", leo), encodeListOp("remove", kit)])).toEqual([
      leo.toLowerCase(),
    ]);
  });

  it("mints first when there's no list, in the same batch; one call for several people otherwise", () => {
    const first = buildFollowCalls([kit, leo], false, SLOT);
    expect(first.map((c) => c.to)).toEqual([EFP_LIST_MINTER, EFP_LIST_RECORDS]);
    expect(decodeFunctionData({ abi: efpListMinterAbi, data: first[0].data }).args).toEqual([
      encodeListStorageLocation(SLOT),
    ]);
    const later = buildFollowCalls([kit, leo], true, SLOT);
    expect(later).toHaveLength(1);
    expect(decodeFunctionData({ abi: efpListRecordsAbi, data: later[0].data }).args).toEqual([
      SLOT,
      [encodeListOp("add", kit), encodeListOp("add", leo)],
    ]);
    const remove = buildUnfollowCalls([kit], SLOT);
    expect(decodeFunctionData({ abi: efpListRecordsAbi, data: remove[0].data }).args).toEqual([
      SLOT,
      [encodeListOp("remove", kit)],
    ]);
    for (const c of [...first, ...later, ...remove]) expect(c.value).toBe(0n);
  });
});

describe("contacts batches", () => {
  it("adds only new people, never the user, and mints a list for a first contact", () => {
    const calls = addContactsCalls(user, [kit, leo, user, leo], mine);
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: efpListRecordsAbi, data: calls[0].data }).args).toEqual([
      SLOT,
      [encodeListOp("add", leo)],
    ]);
    const first = addContactsCalls(user, [kit], none, () => 99n);
    expect(first.map((c) => c.to)).toEqual([EFP_LIST_MINTER, EFP_LIST_RECORDS]);
  });

  it("stops with plain words instead of building a useless or harmful batch", () => {
    expect(() => addContactsCalls(user, [kit], mine)).toThrow(CONTACTS_STOP.already);
    // A list kept on another chain is never replaced by a new primary list.
    expect(() => addContactsCalls(user, [leo], { addresses: [], hasList: true, slot: null })).toThrow(
      CONTACTS_STOP.elsewhere,
    );
    const many = Array.from({ length: MAX_LIST_OPS + 1 }, (_, i) => numberToHex(i + 1, { size: 20 }) as Address);
    expect(() => addContactsCalls(user, many, mine)).toThrow(CONTACTS_STOP.tooMany);
    expect(() => removeContactCalls(user, leo, mine)).toThrow(CONTACTS_STOP.gone);
    expect(removeContactCalls(user, kit, mine)).toHaveLength(1);
  });
});

describe("the allowlist's EFP rules", () => {
  const apply = (slot: bigint, ops: Hex[]) => ({
    to: EFP_LIST_RECORDS as Address,
    data: encodeFunctionData({ abi: efpListRecordsAbi, functionName: "applyListOps", args: [slot, ops] }),
    value: 0n,
  });
  const mint = (location: Hex) => ({
    to: EFP_LIST_MINTER as Address,
    data: encodeFunctionData({ abi: efpListMinterAbi, functionName: "easyMint", args: [location] }),
    value: 0n,
  });

  it("lets ops through only on the user's own slot: the one read from Base, or the one minted in the batch", () => {
    const op = [encodeListOp("add", kit)];
    expect(() => assertAllowed(user, [apply(SLOT, op)], { listSlot: SLOT })).not.toThrow();
    expect(() => assertAllowed(user, [mint(encodeListStorageLocation(7n)), apply(7n, op)])).not.toThrow();
    expect(() => assertAllowed(user, [apply(SLOT, op)])).toThrow(/unexpected arguments to applyListOps/);
    expect(() => assertAllowed(user, [apply(SLOT + 1n, op)], { listSlot: SLOT })).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [mint(encodeListStorageLocation(7n)), apply(8n, op)])).toThrow(
      /unexpected arguments/,
    );
  });

  it("allows only add and remove ops of one address, and not too many", () => {
    const tag = "0x010301010000000000000000000000000000000000000000" as Hex;
    expect(() => assertAllowed(user, [apply(SLOT, [tag])], { listSlot: SLOT })).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [apply(SLOT, [])], { listSlot: SLOT })).toThrow(/unexpected arguments/);
    const many = Array.from({ length: MAX_LIST_OPS + 1 }, () => encodeListOp("add", kit));
    expect(() => assertAllowed(user, [apply(SLOT, many)], { listSlot: SLOT })).toThrow(/unexpected arguments/);
  });

  it("mints only a list on Base in EFP's records contract, with no value", () => {
    const otherChain =
      `0x0101${numberToHex(1n, { size: 32 }).slice(2)}${EFP_LIST_RECORDS.slice(2).toLowerCase()}${numberToHex(7n, { size: 32 }).slice(2)}` as Hex;
    expect(() => assertAllowed(user, [mint(otherChain)])).toThrow(/unexpected arguments to easyMint/);
    const otherRecords = encodeListStorageLocation(7n).replace(
      EFP_LIST_RECORDS.slice(2).toLowerCase(),
      "11".repeat(20),
    ) as Hex;
    expect(() => assertAllowed(user, [mint(otherRecords)])).toThrow(/unexpected arguments/);
    expect(() => assertAllowed(user, [{ ...mint(encodeListStorageLocation(7n)), value: 1n }])).toThrow(
      /unexpected value/,
    );
  });

  it("takes no calls to EFP's registry or account metadata, nor other functions on the records contract", () => {
    const setValue = {
      to: EFP_ACCOUNT_METADATA as Address,
      data: encodeFunctionData({ abi: efpAccountMetadataAbi, functionName: "getValue", args: [user, "primary-list"] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [setValue])).toThrow(/unexpected target/);
    expect(() => assertAllowed(user, [{ to: EFP_LIST_REGISTRY as Address, data: "0x", value: 0n }])).toThrow(
      /unexpected target/,
    );
    const count = {
      to: EFP_LIST_RECORDS as Address,
      data: encodeFunctionData({ abi: efpListRecordsAbi, functionName: "getListOpCount", args: [SLOT] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [count], { listSlot: SLOT })).toThrow(/unexpected call/);
  });
});

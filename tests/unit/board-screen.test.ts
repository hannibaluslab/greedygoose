import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { addCandidates, boardChanges, boardPeople, boardState, sheetPersonOf } from "@/lib/board/view";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const ANN = "0x00000000000000000000000000000000000000bb" as Address;
const BOB = "0x00000000000000000000000000000000000000cc" as Address;
const nameOf = (a: string) => (a.toLowerCase() === ANN ? "ann.justan.id" : null);
const rows = [
  { account: ME, pct: 0.1, rank: 1 },
  { account: ANN, pct: null, rank: null },
];

describe("the Leaderboard tab's derivations", () => {
  it("marks you and your contacts, names them, and lists contacts not on the board", () => {
    const { people, offBoard } = boardPeople({ rows, contacts: [ANN, BOB], address: ME, nameOf });
    expect(people.map((p) => [p.you, p.contact, p.name])).toEqual([
      [true, false, null],
      [false, true, "ann.justan.id"],
    ]);
    expect(offBoard).toEqual([{ account: BOB, name: null }]);
  });

  it("is soon, loading, unread or ready, in that order", () => {
    const read = { pending: false, read: true };
    const base = { open: true, filter: "all" as const, board: read, contacts: read, people: [], offBoard: [] };
    expect(boardState({ ...base, open: false }).kind).toBe("soon");
    expect(boardState({ ...base, board: { pending: true, read: false } }).kind).toBe("loading");
    expect(boardState({ ...base, board: { pending: false, read: false } })).toEqual({ kind: "error", what: "board" });
    expect(boardState({ ...base, filter: "contacts", contacts: { pending: false, read: false } })).toEqual({
      kind: "error",
      what: "contacts",
    });
    expect(boardState(base).kind).toBe("ready");
  });

  it("opens a person on the board or a contact off it, nobody else", () => {
    const { people } = boardPeople({ rows, contacts: [ANN, BOB], address: ME, nameOf });
    const isContact = (a: string) => [ANN, BOB].includes(a.toLowerCase() as Address);
    expect(sheetPersonOf(ANN, people, isContact, nameOf)?.account).toBe(ANN);
    expect(sheetPersonOf(BOB, people, isContact, nameOf)).toEqual({
      account: BOB,
      name: null,
      contact: true,
      you: false,
    });
    expect(sheetPersonOf("0x00000000000000000000000000000000000000dd", people, isContact, nameOf)).toBeNull();
  });

  it("says what each place would sign", () => {
    const c = boardChanges({
      user: ME,
      person: { account: ANN, you: false, contact: true },
      personShown: true,
      adding: true,
      picked: new Set([BOB]),
    });
    expect(c.personChange).toEqual({ verb: "remove", user: ME, targets: [ANN] });
    expect(c.addChange).toEqual({ verb: "add", user: ME, targets: [BOB] });
    // Nothing ticked, or the sheet closed: nothing to add.
    expect(
      boardChanges({ user: ME, person: null, personShown: false, adding: true, picked: new Set() }).addChange,
    ).toBeNull();
    expect(
      boardChanges({ user: ME, person: null, personShown: false, adding: false, picked: new Set([BOB]) }).addChange,
    ).toBeNull();
  });
});

describe("Add contact's list", () => {
  const people = [
    { account: ME, name: "me.justan.id", pct: 0.1, rank: 1, you: true, contact: false },
    { account: ANN, name: "ann.justan.id", pct: 0.05, rank: 2, you: false, contact: true },
    { account: BOB, name: "bob.justan.id", pct: -0.02, rank: 3, you: false, contact: false },
  ];

  it("lists everyone on the board but you and your contacts, in board order", () => {
    expect(addCandidates(people, "").map((c) => c.account)).toEqual([BOB]);
  });

  it("narrows by any part of a name or an address as you type", () => {
    expect(addCandidates(people, "BO").map((c) => c.account)).toEqual([BOB]);
    expect(addCandidates(people, "00cc").map((c) => c.account)).toEqual([BOB]);
    expect(addCandidates(people, "zed")).toEqual([]);
    // The parent every name shares doesn't match a plain word; typed with a dot, it does.
    expect(addCandidates(people, "justan")).toEqual([]);
    expect(addCandidates(people, "bob.jus").map((c) => c.account)).toEqual([BOB]);
    // Ticked stays listed whatever is typed.
    expect(addCandidates(people, "zed", null, new Set([BOB.toLowerCase()])).map((c) => c.account)).toEqual([BOB]);
  });

  it("puts who Find found on top, once, and never you or a contact", () => {
    const rae = {
      account: "0x00000000000000000000000000000000000000dd" as Address,
      name: "rae.eth",
      pct: null,
      onBoard: false,
    };
    expect(addCandidates(people, "", rae).map((c) => c.account)).toEqual([rae.account, BOB]);
    expect(addCandidates(people, "", { ...rae, account: BOB, onBoard: true }).map((c) => c.account)).toEqual([BOB]);
    expect(addCandidates(people, "", { ...rae, account: ANN })).toEqual([
      { account: BOB, name: "bob.justan.id", pct: -0.02, onBoard: true },
    ]);
  });
});

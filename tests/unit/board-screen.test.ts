import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { boardChanges, boardPeople, boardState, sheetPersonOf } from "@/lib/board/view";

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
      found: { account: BOB, you: false, contact: false },
      byName: true,
      picking: true,
      picked: new Set([BOB]),
    });
    expect(c.personChange).toEqual({ verb: "remove", user: ME, targets: [ANN] });
    expect(c.nameChange).toEqual({ verb: "add", user: ME, targets: [BOB] });
    expect(c.pickChange).toEqual({ verb: "add", user: ME, targets: [BOB] });
  });
});

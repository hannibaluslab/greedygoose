import { describe, expect, it } from "vitest";
import { numberToHex, type Address } from "viem";
import { BOARD_PAGE, boardPct, boardSections, othersLine, personLabel, type BoardPerson } from "@/lib/board/view";

const addr = (i: number) => numberToHex(i + 1, { size: 20 }) as Address;
const person = (i: number, over: Partial<BoardPerson> = {}): BoardPerson => ({
  account: addr(i),
  name: null,
  pct: 0.1 - i / 1000,
  rank: i + 1,
  you: false,
  contact: false,
  ...over,
});

describe("boardSections", () => {
  it("All: the first page, then your own row pinned after a gap when you're further down", () => {
    const people = Array.from({ length: 80 }, (_, i) => person(i, { you: i === 69 }));
    const s = boardSections(people, [], "all");
    expect(s.ranked).toHaveLength(BOARD_PAGE + 2);
    expect(s.ranked[BOARD_PAGE]).toEqual({ kind: "gap", key: "gap-you" });
    expect(s.ranked.at(-1)).toMatchObject({ kind: "row", person: { rank: 70, you: true } });
  });

  it("All: on the first page you aren't repeated; a longer board ends with a gap", () => {
    const people = Array.from({ length: 60 }, (_, i) => person(i, { you: i === 3 }));
    const s = boardSections(people, [], "all");
    expect(s.ranked.filter((l) => l.kind === "row" && l.person.you)).toHaveLength(1);
    expect(s.ranked.at(-1)).toEqual({ kind: "gap", key: "gap-end" });
  });

  it("puts the not-ranked-yet after, and Contacts filters the same board to your contacts and you", () => {
    const people = [
      person(0, { contact: true }),
      person(1),
      person(2, { you: true }),
      person(3, { pct: null, rank: null, contact: true }),
      person(4, { pct: null, rank: null }),
    ];
    const all = boardSections(people, [], "all");
    // On All, only you and your contacts are drawn among those not ranked yet; everyone else is a count.
    expect(all.unranked.map((p) => p.account)).toEqual([addr(3)]);
    expect(all.unrankedOthers).toBe(1);
    const offBoard = [{ account: addr(9), name: "kit.justan.id" }];
    const c = boardSections(people, offBoard, "contacts");
    expect(c.ranked.map((l) => (l.kind === "row" ? l.person.rank : l.key))).toEqual([1, 3]);
    expect(c.unranked.map((p) => p.account)).toEqual([addr(3)]);
    expect(c.offBoard).toEqual(offBoard);
  });
});

describe("accounts that join and do nothing", () => {
  it("never become rows on All: a thousand of them are one line", () => {
    const junk = Array.from({ length: 1_000 }, (_, i) => person(i + 10, { pct: null, rank: null }));
    const s = boardSections([person(0), person(1, { you: true, pct: null, rank: null }), ...junk], [], "all");
    expect(s.unranked.map((p) => p.you)).toEqual([true]);
    expect(s.unrankedOthers).toBe(1_000);
    expect(othersLine(1_000, true)).toBe("And 1,000 others.");
    expect(othersLine(1, false)).toBe("1 person.");
  });
});

describe("board words", () => {
  it("shows percent with one decimal and a real minus", () => {
    expect(boardPct(0.12345)).toBe("+12.3%");
    expect(boardPct(-0.0304)).toBe("−3.0%");
    expect(boardPct(0.0004)).toBe("0.0%");
    expect(boardPct(-0.0004)).toBe("0.0%");
    expect(boardPct(0)).toBe("0.0%");
  });

  it("names a row You, its JAW name, or its short address", () => {
    expect(personLabel({ account: addr(1), name: "sam.justan.id" }, true)).toBe("You");
    expect(personLabel({ account: addr(1), name: "sam.justan.id" })).toBe("sam.justan.id");
    expect(personLabel({ account: "0x1234567890abcdef1234567890abcdef12345678", name: null })).toBe("0x1234…5678");
  });
});

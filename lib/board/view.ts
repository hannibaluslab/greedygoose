import type { Address } from "viem";
import { shortAddress } from "@/lib/formatting";

/** Ranked rows shown on All before the list stops; your own row is pinned under them when it is further down. */
export const BOARD_PAGE = 50;

export type BoardFilter = "all" | "contacts";

/** One person on the board, as the screen draws them: percent only. */
export type BoardPerson = {
  account: Address;
  /** JAW name ("sam.justan.id"), null without one (or before it loads). */
  name: string | null;
  /** Return since joining as a fraction; null when not ranked yet. */
  pct: number | null;
  rank: number | null;
  you: boolean;
  contact: boolean;
};

/** A contact who isn't on the board: they haven't made a move in GreedyGoose yet. */
export type OffBoard = { account: Address; name: string | null };

type BoardLine = { kind: "row"; person: BoardPerson } | { kind: "gap"; key: string };

type BoardSections = {
  ranked: BoardLine[];
  /** Not ranked yet, drawn as rows: you and your contacts. */
  unranked: BoardPerson[];
  /** Everyone else not ranked yet (All only): a count, not rows, however many accounts join and do nothing. */
  unrankedOthers: number;
  /** Contacts not on the board (Contacts only). */
  offBoard: OffBoard[];
};

/**
 * What the board shows under a filter. All: everyone ranked, the first BOARD_PAGE of them, with your own row pinned
 * after a gap when it is further down (as the booth's board did); then, not ranked yet, you and your contacts as rows
 * and everyone else as a count. Contacts: the same board filtered to the people you added, and you, with their ranks on
 * the whole board; then your contacts who aren't on it yet.
 */
export function boardSections(
  people: readonly BoardPerson[],
  offBoard: readonly OffBoard[],
  filter: BoardFilter,
): BoardSections {
  const shown = filter === "contacts" ? people.filter((p) => p.contact || p.you) : people;
  const ranked = shown.filter((p) => p.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const unranked = shown.filter((p) => p.rank === null);
  if (filter === "contacts") {
    return {
      ranked: ranked.map((person) => ({ kind: "row", person })),
      unranked,
      unrankedOthers: 0,
      offBoard: [...offBoard],
    };
  }
  const top = ranked.slice(0, BOARD_PAGE);
  const lines: BoardLine[] = top.map((person) => ({ kind: "row", person }));
  const you = ranked.find((p) => p.you);
  if (you && !top.includes(you)) lines.push({ kind: "gap", key: "gap-you" }, { kind: "row", person: you });
  else if (ranked.length > top.length) lines.push({ kind: "gap", key: "gap-end" });
  const known = unranked.filter((p) => p.you || p.contact);
  return { ranked: lines, unranked: known, unrankedOthers: unranked.length - known.length, offBoard: [] };
}

/** The line under the people not ranked yet on All: how many others there are. */
export function othersLine(n: number, withRows: boolean): string {
  const count = n.toLocaleString("en-US");
  if (withRows) return n === 1 ? "And 1 other." : `And ${count} others.`;
  return n === 1 ? "1 person." : `${count} people.`;
}

/** A row's label: "You" for you, else the JAW name, else the short address. */
export function personLabel(p: { account: Address; name: string | null }, you = false): string {
  if (you) return "You";
  return p.name ?? shortAddress(p.account);
}

/** The board's one number: "+12.4%", "−3.0%", "0.0%". One decimal, so it reads as a rank, not an amount. */
export function boardPct(pct: number): string {
  const shown = Math.abs(pct * 100).toFixed(1);
  if (Number(shown) === 0) return "0.0%";
  // "−" (U+2212), as formatSignedPct and the boards write it.
  return `${pct < 0 ? "−" : "+"}${shown}%`;
}

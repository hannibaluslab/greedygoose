"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { numberToHex, type Address } from "viem";
import { AddByNameSheet, type NameLookup } from "@/components/gg/leaderboard/AddByNameSheet";
import { BoardView, PickBar } from "@/components/gg/leaderboard/BoardView";
import { PersonSheet } from "@/components/gg/leaderboard/PersonSheet";
import { rankRows, returnSinceJoining } from "@/lib/board/score";
import { rankWall } from "@/lib/board/wall";
import type { BoardFilter, BoardPerson, BoardState, BoardTab, OffBoard, WallState } from "@/lib/board/view";

/*
 * Dev only: the Leaderboard tab in each state it can be in, from fixtures run through the app's own score and ranking
 * (returnSinceJoining, rankRows). Nothing here reads the chain.
 *   /dev/ui/board                 the board, you 4th, some contacts, two not ranked yet
 *   ?view=far                     70 people, you 63rd: your row pinned under the first page
 *   ?view=crowd                   the board plus 300 accounts that joined and did nothing: one line, not 300 rows
 *   ?view=soon|loading|error|contacts-error|empty
 *   &filter=contacts              the same board filtered to your contacts
 *   &pick=1                       "Add several", two ticked
 *   &sheet=person|contact|you|unranked|offboard|name|name-eth (a name that only gives an Ethereum address)
 *   &tab=wall                     Greedy Fatalities: &wall=few (default, you on it), many, empty, loading, error
 *   &wall=off                     the one board as it is before the Wall opens (All | Contacts as a pill)
 * Adding and removing go straight to JAW's own sheet in the app; here they only say so.
 */

const NOTHING_SIGNED = () => toast("Dev gallery: nothing is signed");
const addr = (i: number) => numberToHex(0xa000 + i, { size: 20 }) as Address;
const YOU = addr(3);

/** [name, worth at joining, put in, taken out, worth now, most credit in use] in dollars, as the board reads them. */
const FIXTURE: [string | null, number, number, number, number, number][] = [
  ["mira.justan.id", 1_200, 0, 0, 1_386, 0],
  ["omar.justan.id", 300, 200, 0, 572, 0],
  ["jules.justan.id", 5_000, 0, 1_000, 4_420, 2_000],
  ["sam.justan.id", 800, 400, 0, 1_262, 300],
  ["kit.justan.id", 2_500, 0, 0, 2_560, 0],
  [null, 640, 0, 0, 640, 0],
  ["leo.justan.id", 150, 50, 0, 191, 0],
  ["ana.justan.id", 9_000, 1_000, 0, 9_700, 4_000],
  ["noor.justan.id", 410, 0, 0, 371, 0],
  ["theo.justan.id", 75, 0, 0, 61, 0],
  ["ivy.justan.id", 12, 0, 0, 12, 0],
  [null, 5, 3, 0, 8, 0],
];
const CONTACTS = new Set([addr(0), addr(4), addr(6), addr(10)]);

function people(rows: typeof FIXTURE): BoardPerson[] {
  const scored = rows.map(([, worthAtJoin, putIn, takenOut, worthNow, peakCredit], i) => ({
    account: addr(i),
    joinedAt: BigInt(100 + i),
    pct: returnSinceJoining({ worthAtJoin, putIn, takenOut, worthNow, peakCredit }).pct,
  }));
  return rankRows(scored).map((r) => {
    const i = Number(r.joinedAt - 100n);
    return {
      account: r.account,
      name: rows[i][0],
      pct: r.pct,
      rank: r.rank,
      you: r.account === YOU,
      contact: CONTACTS.has(r.account),
    };
  });
}

/** 70 people, you 63rd. */
function far(): BoardPerson[] {
  const rows = Array.from(
    { length: 70 },
    (_, i) => [`p${i + 1}.justan.id`, 1_000, 0, 0, 1_300 - i * 6, 0] as (typeof FIXTURE)[number],
  );
  rows[62] = ["sam.justan.id", 1_000, 0, 0, 1_300 - 62 * 6, 0];
  return people(rows).map((p) => ({ ...p, you: p.name === "sam.justan.id", contact: false }));
}

/**
 * The Wall's fixtures, ranked by the app's own rankWall: [name, multiple at the sale, days ago]. Real-range numbers
 * (about 1.2x with cash kept to about 5x with credit all in stock, DECISIONS 2026-10-21), never the film's 14.2x.
 */
const WALL_FEW: [string | null, number | "wiped", number][] = [
  ["degen.justan.id", 4.71, 1],
  [null, 3.92, 3],
  ["kit.justan.id", 1.73, 3],
];
const NOW_SEC = Math.floor(new Date("2026-10-25T12:00:00Z").getTime() / 1000);

function wallPeople(rows: typeof WALL_FEW, you?: number): WallState {
  const ranked = rankWall(
    rows.map(([, multiple, days], i) => ({ account: addr(100 + i), block: BigInt(1_000 - days), multiple })),
  );
  return {
    kind: "ready",
    people: ranked.map((r) => {
      const i = Number(BigInt(r.account) - BigInt(addr(100)));
      return {
        account: r.account,
        name: rows[i][0],
        rank: r.rank,
        multiple: r.multiple,
        time: NOW_SEC - rows[i][2] * 86_400,
        you: i === you,
      };
    }),
  };
}

/** 25 rows: one wiped out on top, then 4.9x down to 1.2x. */
function wallMany(): typeof WALL_FEW {
  const rows: typeof WALL_FEW = [["yolo.justan.id", "wiped", 2]];
  for (let i = 0; i < 24; i++) rows.push([i % 5 === 3 ? null : `g${i + 1}.justan.id`, 4.9 - i * 0.16, (i % 9) + 1]);
  return rows;
}

function wallState(v: string | null): WallState {
  if (v === "loading") return { kind: "loading" };
  if (v === "error") return { kind: "error" };
  if (v === "empty") return { kind: "ready", people: [] };
  if (v === "many") return wallPeople(wallMany());
  return wallPeople(WALL_FEW, 2);
}

const OFF_BOARD: OffBoard[] = [
  { account: addr(40), name: "rae.justan.id" },
  { account: addr(41), name: null },
];

export function BoardGallery() {
  const q = useSearchParams();
  const router = useRouter();
  const view = q.get("view");
  const [filter, setFilter] = useState<BoardFilter>(q.get("filter") === "contacts" ? "contacts" : "all");
  const [picking, setPicking] = useState(q.get("pick") === "1");
  const [tab, setTab] = useState<BoardTab>(q.get("tab") === "wall" ? "wall" : "heroes");
  const wallOn = q.get("wall") !== "off";
  const crowd = Array.from({ length: 300 }, () => [null, 0, 0, 0, 0, 0] as (typeof FIXTURE)[number]);
  const list =
    view === "far" ? far() : view === "empty" ? [] : people(view === "crowd" ? [...FIXTURE, ...crowd] : FIXTURE);
  const [picked, setPicked] = useState<Set<string>>(
    new Set(q.get("pick") === "1" ? [addr(1), addr(2)].map((a) => a.toLowerCase()) : []),
  );
  const sheet = q.get("sheet");
  const state: BoardState =
    view === "soon"
      ? { kind: "soon" }
      : view === "loading"
        ? { kind: "loading" }
        : view === "error"
          ? { kind: "error", what: "board" }
          : view === "contacts-error"
            ? { kind: "error", what: "contacts" }
            : { kind: "ready", people: list, offBoard: view === "empty" ? [] : OFF_BOARD };

  const find = (i: number) => list.find((p) => p.account === addr(i)) ?? null;
  const sheetPerson =
    sheet === "person"
      ? find(1)
      : sheet === "contact"
        ? find(0)
        : sheet === "you"
          ? find(3)
          : sheet === "unranked"
            ? find(10)
            : sheet === "offboard"
              ? { ...OFF_BOARD[0], contact: true as const, you: false as const }
              : null;
  const close = () => {
    const next = new URLSearchParams(q);
    next.delete("sheet");
    router.replace(`/dev/ui/board?${next}`);
  };
  const lookup: NameLookup =
    sheet === "name-eth"
      ? { kind: "found", name: "rae.eth", account: addr(42), you: false, contact: false, onBoard: false, onBase: false }
      : {
          kind: "found",
          name: "rae.justan.id",
          account: addr(40),
          you: false,
          contact: false,
          onBoard: false,
          onBase: true,
        };

  return (
    <>
      <BoardView
        tabs={
          wallOn
            ? {
                tab,
                onTab: (t) => {
                  setTab(t);
                  setPicking(false);
                },
                wall: wallState(q.get("wall")),
                onWallRetry: NOTHING_SIGNED,
              }
            : undefined
        }
        filter={filter}
        onFilter={(f) => {
          setFilter(f);
          setPicking(false);
        }}
        state={state}
        onRetry={NOTHING_SIGNED}
        picking={picking}
        picked={picked}
        onPickToggle={(a) =>
          setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(a.toLowerCase())) next.delete(a.toLowerCase());
            else next.add(a.toLowerCase());
            return next;
          })
        }
        onPickStart={() => setPicking(true)}
        onPickStop={() => {
          setPicking(false);
          setPicked(new Set());
        }}
        onOpen={(p) => {
          const i = list.findIndex((x) => x.account === p.account);
          const s =
            p.account === YOU
              ? "you"
              : CONTACTS.has(p.account)
                ? "contact"
                : i >= 0 && list[i].pct === null
                  ? "unranked"
                  : "person";
          router.replace(`/dev/ui/board?${new URLSearchParams({ ...Object.fromEntries(q), sheet: s })}`);
        }}
        onAddByName={() =>
          router.replace(`/dev/ui/board?${new URLSearchParams({ ...Object.fromEntries(q), sheet: "name" })}`)
        }
        pickBar={picking ? <PickBar count={picked.size} phase="idle" onAdd={NOTHING_SIGNED} /> : undefined}
      />
      <PersonSheet
        open={!!sheetPerson}
        onClose={close}
        person={sheetPerson}
        phase="idle"
        error={null}
        note={null}
        preview={false}
        onAdd={NOTHING_SIGNED}
        onRemove={NOTHING_SIGNED}
      />
      <AddByNameSheet
        open={sheet === "name" || sheet === "name-eth"}
        onClose={close}
        lookup={sheet === "name" || sheet === "name-eth" ? lookup : { kind: "idle" }}
        onLookup={NOTHING_SIGNED}
        phase="idle"
        error={null}
        note={null}
        preview={false}
        onAdd={NOTHING_SIGNED}
      />
    </>
  );
}

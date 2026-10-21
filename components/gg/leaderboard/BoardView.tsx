"use client";

import type { ReactNode } from "react";
import { buttonClass } from "../kit/Button";
import { Initial } from "../kit/Initial";
import { SegmentedControl } from "../kit/SegmentedControl";
import { TabHeader } from "../Screen";
import { TabBar } from "../TabBar";
import { BoardIcon, PlusIcon } from "../kit/icons";
import {
  boardSections,
  othersLine,
  personLabel,
  type BoardFilter,
  type BoardPerson,
  type BoardState,
  type BoardTab,
  type OffBoard,
  type WallState,
} from "@/lib/board/view";
import { RetryButton } from "../kit/RetryButton";
import { BOARD_COPY } from "@/lib/board/copy";
import { BoardRowItem, Gap, List, Note, Section, Skeleton } from "./BoardRow";
import { WallBody } from "./WallView";

/*
 * The Leaderboard tab (Adrian, 2026-10-15): one board, All | Contacts. Everyone is on it from their first move, ranked
 * by return since joining, in percent only: no dollars, no Safe / Watch / Act, and nothing on it to buy, sell or take
 * credit with. Contacts are the user's own list on Base; adding and removing open JAW's own sheet straight away. Plain
 * values in, so the dev gallery (/dev/ui/board) draws every state.
 */

const FILTERS: { value: BoardFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "contacts", label: "Contacts" },
];

/** Once Greedy Fatalities is open: the boards, as one pill, and who Heroes shows, as a quiet toggle under it. */
const TABS: { value: BoardTab; label: string }[] = [
  { value: "heroes", label: BOARD_COPY.heroes },
  { value: "wall", label: BOARD_COPY.wall },
];
const WHO: { value: BoardFilter; label: string }[] = [
  { value: "all", label: BOARD_COPY.everyone },
  { value: "contacts", label: BOARD_COPY.contacts },
];

/** Who Heroes shows: Everyone or Contacts, as two words, the chosen one in ink and underlined. */
function WhoToggle({ value, onChange }: { value: BoardFilter; onChange: (f: BoardFilter) => void }) {
  return (
    <div role="radiogroup" aria-label="Show" className="-ml-1 flex gap-1">
      {WHO.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex h-11 items-center px-1 text-[14px] ${on ? "font-semibold text-ink" : "text-ink-mute"}`}
          >
            <span className={on ? "border-b-[1.5px] border-ink pb-px" : "border-b-[1.5px] border-transparent pb-px"}>
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The two boards (Heroes | Wall of shame), once the Wall is open; undefined keeps the one board as before. */
type Tabs = { tab: BoardTab; onTab: (t: BoardTab) => void; wall: WallState; onWallRetry: () => void };

/**
 * The tab: header, the All | Contacts filter (not while the board opens soon, ruling 47), then the board in its state.
 * Add contact opens one sheet (AddContactSheet) for ticking people or finding them by name.
 */
export function BoardView({
  filter,
  onFilter,
  state,
  onRetry,
  onOpen,
  onAddContact,
  tabs,
}: {
  tabs?: Tabs;
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
  state: BoardState;
  onRetry: () => void;
  onOpen: (p: BoardPerson | OffBoard) => void;
  onAddContact: () => void;
}) {
  const ready = state.kind === "ready" ? state : null;
  const s = ready ? boardSections(ready.people, ready.offBoard, filter) : null;
  // Only the rows on screen can be ticked.
  const row = (p: BoardPerson) => (
    <BoardRowItem key={p.account} person={p} showContact={filter === "all"} onOpen={() => onOpen(p)} />
  );

  let body: ReactNode;
  if (state.kind === "soon") body = <Note icon={<BoardIcon />} title={BOARD_COPY.soon} line={BOARD_COPY.soonLine} />;
  else if (state.kind === "loading") body = <Skeleton />;
  else if (state.kind === "error") {
    const contacts = state.what === "contacts";
    body = (
      <Note
        title={contacts ? BOARD_COPY.contactsError : BOARD_COPY.error}
        line={contacts ? BOARD_COPY.contactsErrorLine : BOARD_COPY.errorLine}
      >
        <RetryButton look="dark" onClick={onRetry} />
      </Note>
    );
  } else if (s && ready) {
    body = (
      <ReadyBoard
        sections={s}
        people={ready.people}
        filter={filter}
        row={row}
        onOpen={onOpen}
        onAddContact={onAddContact}
      />
    );
  }

  const addButton = ready ? (
    <button
      type="button"
      onClick={onAddContact}
      className="-mr-2 flex h-11 items-center gap-1 px-2 text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
    >
      <PlusIcon size={14} />
      {BOARD_COPY.addContact}
    </button>
  ) : null;
  const onWall = tabs?.tab === "wall";

  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 leading-[normal]">
      <TabHeader title="Leaderboard" back="/home" />
      {state.kind !== "soon" && <Controls tabs={tabs} filter={filter} onFilter={onFilter} addButton={addButton} />}
      {onWall ? <WallBody state={tabs.wall} onRetry={tabs.onWallRetry} /> : body}
      <TabBar />
    </div>
  );
}

/**
 * Above the board, not while it opens soon (ruling 47). Before the Wall opens: All | Contacts as a pill, and Add
 * several beside "Return since joining". Once it's open: Heroes | Wall of shame as the pill, and under it, on Heroes
 * only, who it shows (Everyone · Contacts) with Add several at its end.
 */
function Controls({
  tabs,
  filter,
  onFilter,
  addButton,
}: {
  tabs?: Tabs;
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
  addButton: ReactNode;
}) {
  if (!tabs)
    return (
      <>
        <SegmentedControl label="Show" options={FILTERS} value={filter} onChange={onFilter} />
        {addButton && (
          <div className="-mb-1 flex items-center justify-between px-1">
            <span className="text-[13px] text-ink-mid">Return since joining</span>
            {addButton}
          </div>
        )}
      </>
    );
  return (
    <>
      <SegmentedControl label="Board" options={TABS} value={tabs.tab} onChange={tabs.onTab} />
      {tabs.tab === "heroes" && (
        <div className="-my-1 flex items-center justify-between px-1">
          <WhoToggle value={filter} onChange={onFilter} />
          {addButton}
        </div>
      )}
    </>
  );
}

/**
 * The board once it's read: why it's empty (nobody yet, or no contacts, with Add contact), the ranked list (with gaps),
 * the people not ranked yet, the contacts not on the board, and the foot.
 */
function ReadyBoard({
  sections,
  people,
  filter,
  row,
  onOpen,
  onAddContact,
}: {
  sections: ReturnType<typeof boardSections>;
  people: BoardPerson[];
  filter: BoardFilter;
  row: (p: BoardPerson) => ReactNode;
  onOpen: (p: BoardPerson | OffBoard) => void;
  onAddContact: () => void;
}) {
  const nobody = people.length === 0;
  const noContacts = filter === "contacts" && sections.offBoard.length === 0 && !people.some((p) => p.contact);
  return (
    <>
      {filter === "all" && nobody ? (
        <Note icon={<BoardIcon />} title={BOARD_COPY.empty} line={BOARD_COPY.emptyLine} />
      ) : noContacts ? (
        <Note title={BOARD_COPY.noContacts} line={BOARD_COPY.noContactsLine}>
          <button type="button" onClick={onAddContact} className={buttonClass("dark", "md")}>
            <PlusIcon size={18} />
            {BOARD_COPY.addContact}
          </button>
        </Note>
      ) : null}
      {sections.ranked.length > 0 && (
        <List label={filter === "all" ? "Everyone, ranked" : "My contacts, ranked"}>
          {sections.ranked.map((l) => (l.kind === "gap" ? <Gap key={l.key} /> : row(l.person)))}
        </List>
      )}
      {(sections.unranked.length > 0 || sections.unrankedOthers > 0) &&
        !(noContacts && sections.unranked.every((p) => p.you)) && (
          <Section title={BOARD_COPY.notRanked} line={BOARD_COPY.notRankedLine}>
            {sections.unranked.length > 0 && <List label={BOARD_COPY.notRanked}>{sections.unranked.map(row)}</List>}
            {sections.unrankedOthers > 0 && (
              <p className="m-0 px-1 text-[13px] text-ink-mid">
                {othersLine(sections.unrankedOthers, sections.unranked.length > 0)}
              </p>
            )}
          </Section>
        )}
      {sections.offBoard.length > 0 && (
        <Section title={BOARD_COPY.offBoard} line={BOARD_COPY.offBoardLine}>
          <List label={BOARD_COPY.offBoard}>
            {sections.offBoard.map((o) => (
              <li key={o.account}>
                <button
                  type="button"
                  onClick={() => onOpen(o)}
                  className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2 text-left"
                >
                  <span aria-hidden className="w-[22px] shrink-0 text-right font-mono text-[12px] text-ink-mid">
                    –
                  </span>
                  <Initial person={o} />
                  <span className="min-w-0 grow truncate text-[15px] font-semibold">{personLabel(o)}</span>
                </button>
              </li>
            ))}
          </List>
        </Section>
      )}
      <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">
        {BOARD_COPY.foot} {BOARD_COPY.contactsFoot}
      </p>
    </>
  );
}

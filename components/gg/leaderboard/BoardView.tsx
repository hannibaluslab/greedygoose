"use client";

import type { ReactNode } from "react";
import { buttonClass } from "../Button";
import { Initial } from "../Initial";
import { SegmentedControl } from "../SegmentedControl";
import { TabHeader } from "../Screen";
import { TabBar } from "../TabBar";
import { BoardIcon, PlusIcon } from "../icons";
import type { TxPhase } from "@/hooks/useTx";
import {
  boardSections,
  othersLine,
  personLabel,
  type BoardFilter,
  type BoardPerson,
  type BoardState,
  type OffBoard,
} from "@/lib/board/view";
import { RetryButton } from "../RetryButton";
import { BOARD_COPY } from "@/lib/board/copy";
import { BoardRowItem, Gap, List, Note, Section, Skeleton } from "./BoardRow";

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

/**
 * The tab: header, the All | Contacts filter (not while the board opens soon, ruling 47), then the board in its state.
 * `pickBar` floats over the tab bar.
 */
export function BoardView({
  filter,
  onFilter,
  state,
  onRetry,
  picking,
  picked,
  onPickToggle,
  onPickStart,
  onPickStop,
  onOpen,
  onAddByName,
  pickBar,
}: {
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
  state: BoardState;
  onRetry: () => void;
  picking: boolean;
  picked: ReadonlySet<string>;
  onPickToggle: (account: string) => void;
  onPickStart: () => void;
  onPickStop: () => void;
  onOpen: (p: BoardPerson | OffBoard) => void;
  onAddByName: () => void;
  pickBar?: ReactNode;
}) {
  const ready = state.kind === "ready" ? state : null;
  const s = ready ? boardSections(ready.people, ready.offBoard, filter) : null;
  // Only the rows on screen can be ticked.
  const addable = s
    ? [...s.ranked.flatMap((l) => (l.kind === "row" ? [l.person] : [])), ...s.unranked].filter(
        (p) => !p.you && !p.contact,
      ).length
    : 0;
  const isPicked = (a: string) => picked.has(a.toLowerCase());
  const row = (p: BoardPerson) => (
    <BoardRowItem
      key={p.account}
      person={p}
      picking={picking}
      picked={isPicked(p.account)}
      showContact={filter === "all"}
      onOpen={() => onOpen(p)}
      onPick={() => onPickToggle(p.account)}
    />
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
        onAddByName={onAddByName}
      />
    );
  }

  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[calc(env(safe-area-inset-top)+8px)] leading-[normal]">
      <TabHeader title="Leaderboard" back="/home" />
      {/* Ruling 47: no All | Contacts while the board opens soon. */}
      {state.kind !== "soon" && <SegmentedControl label="Show" options={FILTERS} value={filter} onChange={onFilter} />}
      {ready && filter === "all" && addable > 0 && (
        <div className="-mb-1 flex items-center justify-between px-1">
          <span className="text-[13px] text-ink-mid">
            {picking ? "Tick the people to add" : "Return since joining"}
          </span>
          <button
            type="button"
            onClick={picking ? onPickStop : onPickStart}
            className="-mr-2 flex h-11 items-center px-2 text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
          >
            {picking ? "Cancel" : "Add several"}
          </button>
        </div>
      )}
      {body}
      {pickBar && (
        <>
          {/* Space under the last row for the bar. */}
          <div aria-hidden className="h-[72px] shrink-0" />
          {pickBar}
        </>
      )}
      <TabBar />
    </div>
  );
}

/**
 * The board once it's read: why it's empty (nobody yet, or no contacts, with Add by name), the ranked list (with gaps),
 * the people not ranked yet, the contacts not on the board, Add by name on Contacts, and the foot.
 */
function ReadyBoard({
  sections,
  people,
  filter,
  row,
  onOpen,
  onAddByName,
}: {
  sections: ReturnType<typeof boardSections>;
  people: BoardPerson[];
  filter: BoardFilter;
  row: (p: BoardPerson) => ReactNode;
  onOpen: (p: BoardPerson | OffBoard) => void;
  onAddByName: () => void;
}) {
  const nobody = people.length === 0;
  const noContacts = filter === "contacts" && sections.offBoard.length === 0 && !people.some((p) => p.contact);
  return (
    <>
      {filter === "all" && nobody ? (
        <Note icon={<BoardIcon />} title={BOARD_COPY.empty} line={BOARD_COPY.emptyLine} />
      ) : noContacts ? (
        <Note title={BOARD_COPY.noContacts} line={BOARD_COPY.noContactsLine}>
          <button type="button" onClick={onAddByName} className={buttonClass("dark", "md")}>
            <PlusIcon size={18} />
            Add by name
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
      {filter === "contacts" && !noContacts && (
        <button type="button" onClick={onAddByName} className={buttonClass("soft", "md")}>
          <PlusIcon size={18} />
          Add by name
        </button>
      )}
      <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">
        {BOARD_COPY.foot} {BOARD_COPY.contactsFoot}
      </p>
    </>
  );
}

/** "Add several": the count and one Add, floating over the tab bar while the list scrolls. One JAW sheet for all. */
export function PickBar({
  count,
  phase,
  checking = false,
  disabled,
  onAdd,
}: {
  count: number;
  phase: TxPhase;
  /** The batch for the people ticked is still being prepared (useTx): "Checking…" until it's ready. */
  checking?: boolean;
  disabled?: boolean;
  onAdd: () => void;
}) {
  const busy = phase === "simulating" || phase === "signing" || phase === "pending";
  return (
    // Above the tab bar and the Agents button that rises out of it.
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+98px)] z-30 mx-auto max-w-[430px] px-5">
      <div className="pointer-events-auto flex items-center gap-3 rounded-[24px] bg-ink py-2 pl-5 pr-2 shadow-toast">
        <span className="num min-w-0 grow text-[14px] font-semibold text-on-ink" role="status">
          {count === 0 ? "None selected" : `${count} selected`}
        </span>
        <button
          type="button"
          onClick={onAdd}
          disabled={count === 0 || busy || checking || disabled}
          aria-busy={busy || checking}
          className="flex h-11 shrink-0 items-center rounded-full bg-brand px-6 text-[15px] font-bold text-ink disabled:opacity-45"
        >
          {phase === "simulating" || (checking && !busy) ? "Checking…" : phase === "pending" ? "Confirming…" : "Add"}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { buttonClass } from "./Button";
import { Initial } from "./Initial";
import { SegmentedControl } from "./SegmentedControl";
import { TabHeader, WhiteCard } from "./Screen";
import { TabBar } from "./TabBar";
import { TxButton, TxError } from "./TxUi";
import { BoardIcon, CloseIcon, PlusIcon } from "./icons";
import type { TxPhase } from "@/hooks/useTx";
import { boardPct, boardSections, othersLine, personLabel, type BoardFilter, type BoardPerson, type OffBoard } from "@/lib/board/view";
import { shortAddress } from "@/lib/formatting";

/*
 * The Leaderboard tab (Adrian, 2026-10-15): one board, All | Contacts. Everyone is on it from their first move, ranked
 * by return since joining, in percent only: no dollars, no Safe / Watch / Act, and nothing on it to buy, sell or take
 * credit with. Contacts are the user's own list on Base; adding and removing open JAW's own sheet straight away. Plain
 * values in, so the dev gallery (/dev/ui/board) draws every state.
 */

export type BoardState =
  | { kind: "soon" }
  | { kind: "loading" }
  /** The board couldn't be read, or (on Contacts) the contacts list couldn't. */
  | { kind: "error"; what?: "board" | "contacts" }
  | { kind: "ready"; people: BoardPerson[]; offBoard: OffBoard[] };

export const BOARD_COPY = {
  soon: "The leaderboard opens soon.",
  soonLine: "Everyone joins with their first move. It ranks return since joining, in percent.",
  error: "Couldn’t load the board",
  errorLine: "Base didn’t answer, so nothing is shown.",
  contactsError: "Couldn’t load your contacts",
  contactsErrorLine: "Base didn’t answer. The board is still on All.",
  empty: "Nobody’s on the board yet.",
  emptyLine: "You join with your first move in GreedyGoose.",
  noContacts: "No contacts yet.",
  noContactsLine: "Add people from All, or by name.",
  notRanked: "Not ranked yet",
  // No dollar figure on the board, the threshold included (lib/board/score.ts MIN_PUT_IN_USD).
  notRankedLine: "Ranked once they’ve put money in.",
  notRankedYou: "Ranked once you’ve put money in.",
  offBoard: "Not on the board yet",
  offBoardLine: "Joins with their first move in GreedyGoose.",
  foot: "Return since joining, in percent. Money added or taken out doesn’t count as a gain.",
  contactsFoot: "Contacts are saved on-chain, under your name.",
  notOnBase: "This name only gives an Ethereum address. Add it if it’s the same account on Base.",
} as const;

const FILTERS: { value: BoardFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "contacts", label: "Contacts" },
];

/** Green up, red down, as Holdings colour a day's change; grey when it shows as 0.0%. */
const tone = (pct: number) => (Number(Math.abs(pct * 100).toFixed(1)) === 0 ? "text-ink-mid" : pct < 0 ? "text-neg" : "text-pos");

function Tick({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid size-[22px] shrink-0 place-items-center rounded-[7px] border transition ${on ? "border-ink bg-ink text-brand" : "border-line-strong bg-card text-transparent"}`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12l5 5 9-10" />
      </svg>
    </span>
  );
}

/**
 * One person: rank, mark, name and their percent. Your own row is lit. While picking, the rank becomes a tick for
 * anyone who can be added; you and your contacts can't be ticked.
 */
export function BoardRowItem({
  person, picking = false, picked = false, onOpen, onPick, showContact = true,
}: {
  person: BoardPerson;
  picking?: boolean;
  picked?: boolean;
  onOpen: () => void;
  onPick?: () => void;
  /** Say "Contact" under a contact's name (All); Contacts shows only contacts, so it doesn't. */
  showContact?: boolean;
}) {
  const pickable = picking && !person.you && !person.contact;
  const label = personLabel(person, person.you);
  const value = person.pct === null ? BOARD_COPY.notRanked : boardPct(person.pct);
  return (
    <li>
      <button
        type="button"
        onClick={pickable ? onPick : onOpen}
        aria-current={person.you ? "true" : undefined}
        aria-pressed={pickable ? picked : undefined}
        aria-label={`${person.rank ? `Rank ${person.rank}, ` : ""}${label}${person.contact && !person.you ? ", contact" : ""}: ${value}`}
        className={`flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2 text-left transition ${
          person.you ? "rounded-[16px] bg-[rgba(212,255,60,0.42)]" : ""
        } ${picking && !pickable ? "opacity-45" : ""}`}
      >
        <span className="num w-[22px] shrink-0 text-right font-mono text-[12px] text-ink-mid">
          {pickable ? <Tick on={picked} /> : (person.rank ?? "–")}
        </span>
        <Initial person={person} />
        <span className="flex min-w-0 grow flex-col">
          <span className="truncate text-[15px] font-semibold leading-[1.25]">{label}</span>
          {person.you && person.name ? (
            <span className="truncate text-[12px] leading-[1.3] text-ink-2">{person.name}</span>
          ) : showContact && person.contact ? (
            <span className="text-[12px] leading-[1.3] text-ink-mid">Contact</span>
          ) : null}
        </span>
        {person.pct === null ? (
          <span className="shrink-0 text-[13px] text-ink-mid">{BOARD_COPY.notRanked}</span>
        ) : (
          <span className={`num shrink-0 text-[15px] font-semibold ${tone(person.pct)}`}>{boardPct(person.pct)}</span>
        )}
      </button>
    </li>
  );
}

const Gap = () => (
  <li className="py-0.5 text-center font-mono text-[12px] tracking-[0.2em] text-ink-mid">
    <span aria-hidden>· · ·</span>
    <span className="sr-only">More ranks</span>
  </li>
);

/** A small mono caption over a section, with one plain line under it. */
const Section = ({ title, line, children }: { title: string; line?: string; children: ReactNode }) => (
  <section aria-label={title} className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="label m-0">{title}</h2>
      {line && <p className="m-0 text-[13px] leading-[1.35] text-ink-mid">{line}</p>}
    </div>
    {children}
  </section>
);

const List = ({ label, children }: { label: string; children: ReactNode }) => (
  <WhiteCard className="p-1.5">
    <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
      {children}
    </ol>
  </WhiteCard>
);

function Note({ icon, title, line, children }: { icon?: ReactNode; title: string; line: string; children?: ReactNode }) {
  return (
    <WhiteCard className="flex flex-col gap-3 p-[18px]">
      <div className="flex items-center gap-3">
        {icon && <span aria-hidden className="grid size-[42px] shrink-0 place-items-center rounded-[21px] bg-chip text-ink">{icon}</span>}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[17px] font-semibold leading-[1.25]">{title}</span>
          <span className="text-[14px] leading-snug text-ink-mid">{line}</span>
        </span>
      </div>
      {children}
    </WhiteCard>
  );
}

function Skeleton() {
  return (
    <WhiteCard className="flex flex-col gap-1 p-1.5">
      <span className="sr-only" role="status">Loading the board…</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden className="flex h-[56px] items-center gap-3 px-3.5">
          <div className="h-3 w-4 animate-pulse rounded bg-chip" />
          <div className="size-[34px] animate-pulse rounded-full bg-chip" />
          <div className="h-3.5 grow animate-pulse rounded bg-chip" />
          <div className="h-3.5 w-12 animate-pulse rounded bg-chip" />
        </div>
      ))}
    </WhiteCard>
  );
}

/** The tab: header, the All | Contacts filter, then the board in its state. `pickBar` floats over the tab bar. */
export function BoardView({
  filter, onFilter, state, onRetry, picking, picked, onPickToggle, onPickStart, onPickStop, onOpen, onAddByName, pickBar,
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
    ? [...s.ranked.flatMap((l) => (l.kind === "row" ? [l.person] : [])), ...s.unranked].filter((p) => !p.you && !p.contact).length
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
      <Note title={contacts ? BOARD_COPY.contactsError : BOARD_COPY.error} line={contacts ? BOARD_COPY.contactsErrorLine : BOARD_COPY.errorLine}>
        <button type="button" onClick={onRetry} className={buttonClass("dark", "md")}>
          Try again
        </button>
      </Note>
    );
  } else if (s && ready) {
    const nobody = ready.people.length === 0;
    const noContacts = filter === "contacts" && s.offBoard.length === 0 && !ready.people.some((p) => p.contact);
    body = (
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
        {s.ranked.length > 0 && (
          <List label={filter === "all" ? "Everyone, ranked" : "Your contacts, ranked"}>
            {s.ranked.map((l) => (l.kind === "gap" ? <Gap key={l.key} /> : row(l.person)))}
          </List>
        )}
        {(s.unranked.length > 0 || s.unrankedOthers > 0) && !(noContacts && s.unranked.every((p) => p.you)) && (
          <Section title={BOARD_COPY.notRanked} line={BOARD_COPY.notRankedLine}>
            {s.unranked.length > 0 && <List label={BOARD_COPY.notRanked}>{s.unranked.map(row)}</List>}
            {s.unrankedOthers > 0 && <p className="m-0 px-1 text-[13px] text-ink-mid">{othersLine(s.unrankedOthers, s.unranked.length > 0)}</p>}
          </Section>
        )}
        {s.offBoard.length > 0 && (
          <Section title={BOARD_COPY.offBoard} line={BOARD_COPY.offBoardLine}>
            <List label={BOARD_COPY.offBoard}>
              {s.offBoard.map((o) => (
                <li key={o.account}>
                  <button type="button" onClick={() => onOpen(o)} className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2 text-left">
                    <span aria-hidden className="w-[22px] shrink-0 text-right font-mono text-[12px] text-ink-mid">–</span>
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

  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[calc(env(safe-area-inset-top)+8px)] leading-[normal]">
      <TabHeader title="Leaderboard" back="/home" />
      <SegmentedControl label="Show" options={FILTERS} value={filter} onChange={onFilter} />
      {ready && filter === "all" && addable > 0 && (
        <div className="-mb-1 flex items-center justify-between px-1">
          <span className="text-[13px] text-ink-mid">{picking ? "Tick the people to add" : "Return since joining"}</span>
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
          {/* Room under the last row for the bar. */}
          <div aria-hidden className="h-[72px] shrink-0" />
          {pickBar}
        </>
      )}
      <TabBar />
    </div>
  );
}

/** "Add several": the count and one Add, floating over the tab bar while the list scrolls. One JAW sheet for all. */
export function PickBar({
  count, phase, checking = false, disabled, onAdd,
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

/**
 * A person's sheet: their percent (or why there isn't one) and one action, adding them to your contacts or removing
 * them. Each opens JAW's own sheet straight away.
 */
export function PersonSheet({
  open, onClose, person, phase, checking = false, blocked = false, error, note, preview, onAdd, onRemove,
}: {
  open: boolean;
  onClose: () => void;
  person: (BoardPerson | (OffBoard & { contact: true; you: false })) | null;
  phase: TxPhase;
  /** Its change is still being prepared (useTx): "Checking…" until it's ready. */
  checking?: boolean;
  /** Its change can't go ahead (`error` says why). */
  blocked?: boolean;
  error: string | null;
  /** Why the action can't go ahead (fees, loading). */
  note: string | null;
  preview: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  if (!person) return null;
  const onBoard = "rank" in person;
  const busy = phase === "simulating" || phase === "signing" || phase === "pending";
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={personLabel(person, person.you)}
      description={person.you || person.name ? shortAddress(person.account) : undefined}
    >
      <SheetSteps stepKey={person.account} className="flex flex-col gap-3.5">
        <WhiteCard className="flex flex-col gap-1 px-4 py-3.5">
          <span className="label">Return since joining</span>
          {!onBoard ? (
            <>
              <span className="text-[17px] font-semibold">{BOARD_COPY.offBoard}</span>
              <span className="text-[13px] leading-[1.4] text-ink-mid">{BOARD_COPY.offBoardLine}</span>
            </>
          ) : person.pct === null ? (
            <>
              <span className="text-[17px] font-semibold">{BOARD_COPY.notRanked}</span>
              <span className="text-[13px] leading-[1.4] text-ink-mid">{person.you ? BOARD_COPY.notRankedYou : BOARD_COPY.notRankedLine}</span>
            </>
          ) : (
            <>
              <span className={`num text-[32px] font-semibold leading-[1.15] tracking-[-0.02em] ${tone(person.pct)}`}>{boardPct(person.pct)}</span>
              <span className="text-[13px] text-ink-mid">Rank {person.rank} on the board</span>
            </>
          )}
        </WhiteCard>
        {person.you ? (
          <p className="m-0 px-1 text-[13px] leading-[1.4] text-ink-mid">This is you. {BOARD_COPY.foot}</p>
        ) : person.contact ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={busy || checking || blocked || preview || !!note || phase === "done"}
              aria-busy={busy || checking}
              onClick={onRemove}
              className={buttonClass("soft", "md")}
            >
              {phase === "simulating" || (checking && !busy) ? "Checking…" : phase === "pending" ? "Confirming on Base…" : "Remove from contacts"}
            </button>
            {preview ? (
              <p className="m-0 text-center text-xs text-subtle">Preview mode — sign in to do this.</p>
            ) : (
              note && <p className="m-0 text-center text-xs text-subtle">{note}</p>
            )}
          </div>
        ) : (
          <TxButton label="Add to contacts" size="md" phase={phase} checking={checking} disabled={blocked} note={note} preview={preview} onClick={onAdd} />
        )}
        <TxError error={error} />
        {!person.you && <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">{BOARD_COPY.contactsFoot}</p>}
      </SheetSteps>
    </SheetShell>
  );
}

export type NameLookup =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "none"; name: string }
  /** `onBase` false: the name gave only an Ethereum address, which may not be the same account on Base. */
  | { kind: "found"; name: string | null; account: `0x${string}`; you: boolean; contact: boolean; onBoard: boolean; onBase?: boolean };

/** Add a contact by name: type it, see who it is, then Add. "sam" means sam.justan.id. */
export function AddByNameSheet({
  open, onClose, lookup, onLookup, phase, checking = false, blocked = false, error, note, preview, onAdd,
}: {
  open: boolean;
  onClose: () => void;
  lookup: NameLookup;
  onLookup: (name: string) => void;
  phase: TxPhase;
  /** Its add is still being prepared (useTx): "Checking…" until it's ready. */
  checking?: boolean;
  /** Its add can't go ahead (`error` says why). */
  blocked?: boolean;
  error: string | null;
  note: string | null;
  preview: boolean;
  onAdd: () => void;
}) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) onLookup(text);
  };
  const found = lookup.kind === "found" ? lookup : null;
  return (
    <SheetShell open={open} onOpenChange={(next) => !next && onClose()} title="Add by name" description="Their name, or their address.">
      <SheetSteps stepKey="by-name" className="flex flex-col gap-3.5">
        <form onSubmit={submit} className="flex items-center gap-2 rounded-[18px] border border-line-field bg-card px-4 focus-within:border-ink">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="sam.justan.id"
            aria-label="Name"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            className="h-14 min-w-0 grow bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none"
          />
          {text && (
            <button type="button" aria-label="Clear" onClick={() => setText("")} className="-mx-1.5 grid size-11 shrink-0 place-items-center rounded-full text-ink-mid">
              <CloseIcon size={14} />
            </button>
          )}
          <button type="submit" disabled={!text.trim() || lookup.kind === "looking"} className="-mr-2 h-11 shrink-0 rounded-[16px] bg-ink px-4 text-sm font-semibold text-on-ink disabled:opacity-45">
            {lookup.kind === "looking" ? "Looking…" : "Find"}
          </button>
        </form>
        {lookup.kind === "none" && <p className="m-0 px-1 text-[14px] text-ink-mid">No account goes by {lookup.name}.</p>}
        {found && (
          <WhiteCard className="flex items-center gap-3 px-3.5 py-3">
            <Initial person={{ account: found.account, name: found.name }} />
            <span className="flex min-w-0 grow flex-col">
              <span className="truncate text-[15px] font-semibold">{found.name ?? shortAddress(found.account)}</span>
              <span className="truncate text-[12px] text-ink-mid">
                {shortAddress(found.account)} · {found.onBoard ? "On the board" : BOARD_COPY.offBoard}
              </span>
            </span>
          </WhiteCard>
        )}
        {found && found.onBase === false && !found.you && !found.contact && <p className="m-0 px-1 text-[13px] leading-[1.4] text-ink-mid">{BOARD_COPY.notOnBase}</p>}
        {found && found.you && <p className="m-0 px-1 text-[14px] text-ink-mid">That’s you.</p>}
        {found && !found.you && found.contact && <p className="m-0 px-1 text-[14px] text-ink-mid">Already in your contacts.</p>}
        {found && !found.you && !found.contact && (
          <TxButton label="Add to contacts" size="md" phase={phase} checking={checking} disabled={blocked} note={note} preview={preview} onClick={onAdd} />
        )}
        <TxError error={error} />
        <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">{BOARD_COPY.contactsFoot}</p>
      </SheetSteps>
    </SheetShell>
  );
}

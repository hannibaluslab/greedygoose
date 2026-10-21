"use client";

import { useState, type FormEvent } from "react";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { Initial } from "../kit/Initial";
import { WhiteCard } from "../Screen";
import { TxButton, TxError } from "../TxUi";
import { CloseIcon } from "../kit/icons";
import { Tick, tone } from "./BoardRow";
import type { TxPhase } from "@/hooks/useTx";
import { shortAddress } from "@/lib/formatting";
import { BOARD_COPY } from "@/lib/board/copy";
import { addCandidates, boardPct, type AddCandidate, type BoardPerson } from "@/lib/board/view";

export type NameLookup =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "none"; name: string }
  /** `onBase` false: the name gave only an Ethereum address, which may not be the same account on Base. */
  | {
      kind: "found";
      name: string | null;
      account: `0x${string}`;
      you: boolean;
      contact: boolean;
      onBoard: boolean;
      onBase?: boolean;
    };

/**
 * Add contact (Adrian, 2026-10-21, in place of Add several and Add by name): one sheet. Typing narrows the board's
 * list, a name or an address; Find looks the name up for someone not on the list. Tick as many as you like, then one
 * JAW sheet adds them all. "sam" means sam.justan.id.
 */
export function AddContactSheet({
  open,
  onClose,
  people,
  lookup,
  onLookup,
  picked,
  onToggle,
  phase,
  checking = false,
  blocked = false,
  error,
  note,
  preview,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  /** The board, as the screen has it: you and your contacts are left out of the list. */
  people: readonly BoardPerson[];
  lookup: NameLookup;
  onLookup: (name: string) => void;
  /** Ticked, by lowercase address. */
  picked: ReadonlySet<string>;
  onToggle: (account: `0x${string}`) => void;
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
  const foundCandidate: AddCandidate | null =
    found && !found.you && !found.contact
      ? { account: found.account, name: found.name, pct: null, onBoard: found.onBoard, onBase: found.onBase }
      : null;
  // The one Find found stays listed whatever the field says now.
  const list = addCandidates(people, foundCandidate ? "" : text, foundCandidate, picked);
  const offBase = list.some((c) => c.onBase === false && picked.has(c.account.toLowerCase()));
  const count = picked.size;
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={BOARD_COPY.addContactTitle}
      description={BOARD_COPY.addContactLine}
    >
      <SheetSteps stepKey="add-contact" className="flex flex-col gap-3.5">
        <form
          onSubmit={submit}
          className="flex items-center gap-2 rounded-[18px] border border-line-field bg-card px-4 focus-within:border-ink"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="sam.justan.id"
            aria-label="Name or address"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            className="h-14 min-w-0 grow bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none"
          />
          {text && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setText("")}
              className="-mx-1.5 grid size-11 shrink-0 place-items-center rounded-full text-ink-mid"
            >
              <CloseIcon size={14} />
            </button>
          )}
          <button
            type="submit"
            disabled={!text.trim() || lookup.kind === "looking"}
            className="-mr-2 h-11 shrink-0 rounded-[16px] bg-ink px-4 text-sm font-semibold text-on-ink disabled:opacity-45"
          >
            {lookup.kind === "looking" ? "Looking…" : "Find"}
          </button>
        </form>
        {lookup.kind === "none" && (
          <p className="m-0 px-1 text-[14px] text-ink-mid">No account goes by {lookup.name}.</p>
        )}
        {found?.you && <p className="m-0 px-1 text-[14px] text-ink-mid">That’s you.</p>}
        {found && !found.you && found.contact && (
          <p className="m-0 px-1 text-[14px] text-ink-mid">Already in your contacts.</p>
        )}
        {list.length > 0 ? (
          <WhiteCard className="p-1.5">
            <ul aria-label={BOARD_COPY.addContact} className="m-0 flex list-none flex-col p-0">
              {list.map((c) => (
                <CandidateRow
                  key={c.account}
                  c={c}
                  on={picked.has(c.account.toLowerCase())}
                  onToggle={() => onToggle(c.account)}
                />
              ))}
            </ul>
          </WhiteCard>
        ) : (
          <p className="m-0 px-1 text-[14px] text-ink-mid">
            {text.trim() ? BOARD_COPY.addNoMatch : BOARD_COPY.addNobody}
          </p>
        )}
        {offBase && <p className="m-0 px-1 text-[13px] leading-[1.4] text-ink-mid">{BOARD_COPY.notOnBase}</p>}
        <TxButton
          label="Add to contacts"
          size="md"
          phase={phase}
          checking={checking}
          disabled={blocked || count === 0}
          note={note}
          preview={preview}
          onClick={onAdd}
        />
        <TxError error={error} />
        <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">{BOARD_COPY.contactsFoot}</p>
      </SheetSteps>
    </SheetShell>
  );
}

/** One person to tick: the tick, their mark, their name, and their percent (or that they aren't on the board yet). */
function CandidateRow({ c, on, onToggle }: { c: AddCandidate; on: boolean; onToggle: () => void }) {
  const label = c.name ?? shortAddress(c.account);
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2 text-left"
      >
        <Tick on={on} />
        <Initial person={{ account: c.account, name: c.name }} />
        <span className="flex min-w-0 grow flex-col">
          <span className="truncate text-[15px] font-semibold leading-[1.25]">{label}</span>
          {!c.onBoard && <span className="text-[12px] leading-[1.3] text-ink-mid">{BOARD_COPY.offBoard}</span>}
        </span>
        {c.onBoard &&
          (c.pct === null ? (
            <span className="shrink-0 text-[13px] text-ink-mid">{BOARD_COPY.notRanked}</span>
          ) : (
            <span className={`num shrink-0 text-[15px] font-semibold ${tone(c.pct)}`}>{boardPct(c.pct)}</span>
          ))}
      </button>
    </li>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Initial } from "../Initial";
import { WhiteCard } from "../Screen";
import { TxButton, TxError } from "../TxUi";
import { CloseIcon } from "../icons";
import type { TxPhase } from "@/hooks/useTx";
import { shortAddress } from "@/lib/formatting";
import { BOARD_COPY } from "@/lib/board/copy";

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

/** Add a contact by name: type it, see who it is, then Add. "sam" means sam.justan.id. */
export function AddByNameSheet({
  open,
  onClose,
  lookup,
  onLookup,
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
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Add by name"
      description="Their name, or their address."
    >
      <SheetSteps stepKey="by-name" className="flex flex-col gap-3.5">
        <form
          onSubmit={submit}
          className="flex items-center gap-2 rounded-[18px] border border-line-field bg-card px-4 focus-within:border-ink"
        >
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
        {found && found.onBase === false && !found.you && !found.contact && (
          <p className="m-0 px-1 text-[13px] leading-[1.4] text-ink-mid">{BOARD_COPY.notOnBase}</p>
        )}
        {found && found.you && <p className="m-0 px-1 text-[14px] text-ink-mid">That’s you.</p>}
        {found && !found.you && found.contact && (
          <p className="m-0 px-1 text-[14px] text-ink-mid">Already in your contacts.</p>
        )}
        {found && !found.you && !found.contact && (
          <TxButton
            label="Add to contacts"
            size="md"
            phase={phase}
            checking={checking}
            disabled={blocked}
            note={note}
            preview={preview}
            onClick={onAdd}
          />
        )}
        <TxError error={error} />
        <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">{BOARD_COPY.contactsFoot}</p>
      </SheetSteps>
    </SheetShell>
  );
}

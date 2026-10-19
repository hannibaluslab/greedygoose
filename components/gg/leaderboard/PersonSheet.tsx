"use client";

import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { buttonClass } from "../Button";
import { WhiteCard } from "../Screen";
import { TxButton, TxError } from "../TxUi";
import type { TxPhase } from "@/hooks/useTx";
import { boardPct, personLabel, type BoardPerson, type OffBoard } from "@/lib/board/view";
import { shortAddress } from "@/lib/formatting";
import { BOARD_COPY } from "@/lib/board/copy";
import { tone } from "./BoardRow";

/**
 * A person's sheet: their percent (or why there isn't one) and one action, adding them to your contacts or removing
 * them. Each opens JAW's own sheet straight away.
 */
export function PersonSheet({
  open,
  onClose,
  person,
  phase,
  checking = false,
  blocked = false,
  error,
  note,
  preview,
  onAdd,
  onRemove,
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
              <span className="text-[13px] leading-[1.4] text-ink-mid">
                {person.you ? BOARD_COPY.notRankedYou : BOARD_COPY.notRankedLine}
              </span>
            </>
          ) : (
            <>
              <span className={`num text-[32px] font-semibold leading-[1.15] tracking-[-0.02em] ${tone(person.pct)}`}>
                {boardPct(person.pct)}
              </span>
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
              {phase === "simulating" || (checking && !busy)
                ? "Checking…"
                : phase === "pending"
                  ? "Confirming on Base…"
                  : "Remove from contacts"}
            </button>
            {preview ? (
              <p className="m-0 text-center text-xs text-subtle">Preview mode — sign in to do this.</p>
            ) : (
              note && <p className="m-0 text-center text-xs text-subtle">{note}</p>
            )}
          </div>
        ) : (
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
        {!person.you && <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">{BOARD_COPY.contactsFoot}</p>}
      </SheetSteps>
    </SheetShell>
  );
}

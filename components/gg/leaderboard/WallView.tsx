"use client";

import { RetryButton } from "../kit/RetryButton";
import { List, Note, Skeleton } from "./BoardRow";
import { BOARD_COPY } from "@/lib/board/copy";
import { personLabel, wallDate, wallMultiple, type WallPerson, type WallState } from "@/lib/board/view";

/*
 * The Wall of shame (Adrian, 2026-10-21; SPEC's Greedy Fatalities): everyone who had part of their stock sold to pay
 * what they owe, boldest first, by their leverage when it happened. Named automatically, no opt-out, nothing to tap.
 * Words from BOARD_COPY; never "liquidated" on screen. Plain values in, so the dev gallery draws every state.
 */

/** A lime egg, cracked, on the pale red of Act: the film's mark for a Greedy Fatality. */
function CrackedEgg({ size = 34 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-neg-soft"
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.5} height={size * 0.6} viewBox="0 0 20 24">
        <ellipse cx="10" cy="13.5" rx="8.5" ry="10" fill="#d4ff3c" />
        <polyline
          points="2,11 6,14 9.5,9.5 13,14 18,11"
          fill="none"
          stroke="#8e2a1d"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function WallRow({ person }: { person: WallPerson }) {
  const label = personLabel(person, person.you);
  const multiple = wallMultiple(person.multiple);
  const date = wallDate(person.time);
  return (
    <li
      aria-label={`Rank ${person.rank}, ${label}: ${multiple}, ${date}`}
      className={`flex min-h-[56px] items-center gap-3 px-3.5 py-2 ${person.you ? "rounded-[16px] bg-neg-soft" : ""}`}
    >
      <span className="num w-[22px] shrink-0 text-right font-mono text-[12px] text-ink-mid">{person.rank}</span>
      <CrackedEgg />
      <span className="flex min-w-0 grow flex-col">
        <span className="truncate text-[15px] font-semibold leading-[1.25] text-neg line-through decoration-[1.5px]">
          {label}
        </span>
        {person.you && person.name && (
          <span className="truncate text-[12px] leading-[1.3] text-ink-2">{person.name}</span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span className="num text-[15px] font-bold leading-[1.25] text-neg">{multiple}</span>
        <span className="text-[12px] leading-[1.3] text-ink-mid">{date}</span>
      </span>
    </li>
  );
}

/** The Wall in its state: loading, Base not answering, nobody yet, or its rows under its title and rule. */
export function WallBody({ state, onRetry }: { state: WallState; onRetry: () => void }) {
  if (state.kind === "loading") return <Skeleton />;
  if (state.kind === "error")
    return (
      <Note title={BOARD_COPY.wallError} line={BOARD_COPY.errorLine}>
        <RetryButton look="dark" onClick={onRetry} />
      </Note>
    );
  if (state.people.length === 0)
    return <Note icon={<CrackedEgg size={42} />} title={BOARD_COPY.wallEmpty} line={BOARD_COPY.wallEmptyLine} />;
  return (
    <>
      <div className="flex flex-col gap-0.5 px-1">
        <h2 className="m-0 text-[17px] font-semibold leading-[1.25]">{BOARD_COPY.wallTitle}</h2>
        <p className="m-0 text-[13px] leading-[1.35] text-ink-mid">{BOARD_COPY.wallLine}</p>
      </div>
      <List label={BOARD_COPY.wallTitle}>
        {state.people.map((p) => (
          <WallRow key={p.account} person={p} />
        ))}
      </List>
      <p className="m-0 px-1 text-xs leading-[1.45] text-subtle">{BOARD_COPY.wallFoot}</p>
    </>
  );
}

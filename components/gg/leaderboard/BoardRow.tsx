"use client";

import type { ReactNode } from "react";
import { Initial } from "../Initial";
import { WhiteCard } from "../Screen";
import { boardPct, personLabel, type BoardPerson } from "@/lib/board/view";
import { BOARD_COPY } from "@/lib/board/copy";

/** Green up, red down, as Holdings colour a day's change; grey when it shows as 0.0%. */
export const tone = (pct: number) =>
  Number(Math.abs(pct * 100).toFixed(1)) === 0 ? "text-ink-mid" : pct < 0 ? "text-neg" : "text-pos";

function Tick({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid size-[22px] shrink-0 place-items-center rounded-[7px] border transition ${on ? "border-ink bg-ink text-brand" : "border-line-strong bg-card text-transparent"}`}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
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
  person,
  picking = false,
  picked = false,
  onOpen,
  onPick,
  showContact = true,
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

export const Gap = () => (
  <li className="py-0.5 text-center font-mono text-[12px] tracking-[0.2em] text-ink-mid">
    <span aria-hidden>· · ·</span>
    <span className="sr-only">More ranks</span>
  </li>
);

/** A small mono caption over a section, with one plain line under it. */
export const Section = ({ title, line, children }: { title: string; line?: string; children: ReactNode }) => (
  <section aria-label={title} className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="label m-0">{title}</h2>
      {line && <p className="m-0 text-[13px] leading-[1.35] text-ink-mid">{line}</p>}
    </div>
    {children}
  </section>
);

export const List = ({ label, children }: { label: string; children: ReactNode }) => (
  <WhiteCard className="p-1.5">
    <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
      {children}
    </ol>
  </WhiteCard>
);

export function Note({
  icon,
  title,
  line,
  children,
}: {
  icon?: ReactNode;
  title: string;
  line: string;
  children?: ReactNode;
}) {
  return (
    <WhiteCard className="flex flex-col gap-3 p-[18px]">
      <div className="flex items-center gap-3">
        {icon && (
          <span aria-hidden className="grid size-[42px] shrink-0 place-items-center rounded-[21px] bg-chip text-ink">
            {icon}
          </span>
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[17px] font-semibold leading-[1.25]">{title}</span>
          <span className="text-[14px] leading-snug text-ink-mid">{line}</span>
        </span>
      </div>
      {children}
    </WhiteCard>
  );
}

export function Skeleton() {
  return (
    <WhiteCard className="flex flex-col gap-1 p-1.5">
      <span className="sr-only" role="status">
        Loading the board…
      </span>
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

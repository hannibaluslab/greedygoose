"use client";

import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import type { Address } from "viem";
import { Initial } from "../kit/Initial";
import { CloseIcon } from "../kit/icons";
import type { ToState } from "@/hooks/useSend";
import { shortAddress } from "@/lib/formatting";
import { SEND_COPY, type Recipient } from "@/lib/send";

/** "0x2b8c e2c8 7c16 …": the whole address in fours, so a look-alike that shares its ends can't pass for it. */
const grouped = (a: string) => `0x${a.slice(2).match(/.{4}/g)!.join(" ")}`;

/**
 * To, in the amount card's kit: the field and Find (NYM's "Name, handle, or 0x address" with its Use button), or, once
 * someone is picked, who they are with their address under the name and a way to change it. Under it, why there's no one
 * (a typo, a name that points nowhere) or the recipient's guard.
 */
export function ToCard({
  state,
  recipient,
  text,
  onText,
  onFind,
  onChange,
  disabled,
  note,
  waiting,
}: {
  state: ToState;
  recipient: Recipient | null;
  text: string;
  onText: (value: string) => void;
  onFind: (e: FormEvent) => void;
  onChange: () => void;
  disabled?: boolean;
  note: { text: string; tone: "act" | "watch" } | null;
  waiting: boolean;
}) {
  const looking = state.kind === "looking";
  const card = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const had = useRef(!!recipient);
  // When the field turns into who it is (Find, a paste, a pick), or back (Send to someone else), the control that had
  // focus is gone and focus would drop to the page: keep it in To, on the card, or back in the field.
  useEffect(() => {
    if (!!recipient === had.current) return;
    had.current = !!recipient;
    const active = document.activeElement;
    if (active && active !== document.body && !card.current?.contains(active)) return;
    (recipient ? card.current : input.current)?.focus();
  }, [recipient]);
  const labelClass = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle";
  return (
    <div className="flex flex-col gap-2">
      <div
        ref={card}
        role="group"
        aria-labelledby="send-to-label"
        tabIndex={-1}
        className="flex flex-col gap-2 rounded-[16px] border border-line-field bg-card p-3.5 leading-[normal] outline-none focus-within:border-ink focus:border-ink"
      >
        {recipient ? (
          <span id="send-to-label" className={labelClass}>
            {SEND_COPY.to}
          </span>
        ) : (
          <label id="send-to-label" htmlFor="send-to" className={labelClass}>
            {SEND_COPY.to}
          </label>
        )}
        {recipient ? (
          <div className="flex items-center gap-2.5">
            <Initial person={{ account: recipient.address, name: recipient.name }} size={36} />
            {/* A name over its address, shortened; an address without one in full, in fours. */}
            <span className="num flex min-w-0 grow flex-col gap-0.5">
              <span className="truncate text-[16px] font-semibold tracking-[-0.01em]">
                {recipient.name ?? shortAddress(recipient.address)}
              </span>
              <span
                className={`text-[12px] text-ink-mid ${recipient.name ? "truncate" : "break-words leading-[1.35]"}`}
              >
                {recipient.name ? shortAddress(recipient.address) : grouped(recipient.address)}
              </span>
            </span>
            <button
              type="button"
              aria-label={SEND_COPY.change}
              onClick={onChange}
              disabled={disabled}
              className="relative grid size-8 shrink-0 place-items-center rounded-full bg-[rgba(15,14,11,0.06)] text-ink-mid transition after:absolute after:-inset-1.5 after:content-[''] active:scale-95 disabled:opacity-45"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ) : (
          <form onSubmit={onFind} className="flex items-center gap-2">
            <input
              ref={input}
              id="send-to"
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder={SEND_COPY.toPlaceholder}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              disabled={disabled}
              className="h-11 min-w-0 grow bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none"
            />
            {text && (
              <button
                type="button"
                aria-label="Clear"
                onClick={() => {
                  onText("");
                  input.current?.focus();
                }}
                className="-mx-1.5 grid size-11 shrink-0 place-items-center rounded-full text-ink-mid"
              >
                <CloseIcon size={14} />
              </button>
            )}
            <button
              type="submit"
              disabled={!text.trim() || looking || disabled}
              className="-mr-1 h-11 shrink-0 rounded-[16px] bg-ink px-4 text-sm font-semibold text-on-ink disabled:opacity-45"
            >
              {looking ? SEND_COPY.looking : SEND_COPY.find}
            </button>
          </form>
        )}
      </div>
      {state.kind === "none" && <Note tone="act">{state.text}</Note>}
      {note && <Note tone={note.tone}>{note.text}</Note>}
      {waiting && (
        <p role="status" className="m-0 px-0.5 text-[13px] leading-snug text-subtle">
          {SEND_COPY.checking}
        </p>
      )}
    </div>
  );
}

/** A refusal is an alert; a warning is a status. */
function Note({ tone, children }: { tone: "act" | "watch"; children: ReactNode }) {
  return (
    <p
      role={tone === "act" ? "alert" : "status"}
      className={`m-0 px-0.5 text-[13px] leading-snug ${tone === "act" ? "text-act" : "text-watch-text"}`}
    >
      {children}
    </p>
  );
}

/** NYM's Recents row: a mono label, then round marks with the name's first label (or the short address), one swipe wide. */
export function QuickPicks({
  label,
  people,
  onPick,
  disabled,
}: {
  label: string;
  people: { address: Address; name: string | null }[];
  onPick: (address: Address) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="px-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">{label}</span>
      <div className="-mx-5 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {people.map((p) => (
          <button
            key={p.address}
            type="button"
            onClick={() => onPick(p.address)}
            disabled={disabled}
            aria-label={`Send to ${p.name ?? p.address}`}
            className="flex w-[72px] shrink-0 flex-col items-center gap-1.5 rounded-[14px] py-1 transition active:scale-95 disabled:opacity-45"
          >
            <Initial person={{ account: p.address, name: p.name }} size={44} />
            <span className="w-full truncate text-center text-[12px] text-ink-mid">
              {p.name ? p.name.split(".")[0] : `${p.address.slice(0, 4)}…${p.address.slice(-4)}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

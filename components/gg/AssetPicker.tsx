"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "./icons";
import { StockAvatar } from "./StockAvatar";
import { useClickAway } from "@/hooks/useClickAway";

/** A picker row: the asset's mark and name, the line under it, the right column and whether it can be picked. */
export type PickerRow = {
  id: string;
  name: string;
  mark: ReactNode;
  sub?: string;
  right?: string;
  rightSub?: string;
  /** Anything else on the row's right, before its radio: Repay's status-after pill. */
  aside?: ReactNode;
  disabled?: boolean;
};

/** Cash's mark, at any size: the USDC coin it is held in (Adrian, 2026-10-15: "the cash icon should be usdc"). */
export function CashMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      className="block shrink-0 rounded-full bg-cover bg-center"
      style={{ width: size, height: size, backgroundImage: "url(/tokens/USDC.png)" }}
    />
  );
}

/** The mark for an asset: cash's USDC coin, or the stock's logo. */
export const assetMark = (asset: string, size: number) =>
  asset === "cash" ? <CashMark size={size} /> : <StockAvatar symbol={asset} size={size} />;

/**
 * Cancel the mousedown and click of the tap that is under way, so it presses nothing (and focuses nothing). Undone by
 * that click, by the touch turning into a scroll (pointercancel: no click follows), or after 700ms.
 */
function swallowNextPress() {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e: Event) => {
    stop(e);
    off();
  };
  const off = () => {
    window.clearTimeout(timer);
    document.removeEventListener("mousedown", stop, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("pointercancel", off, true);
  };
  document.addEventListener("mousedown", stop, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointercancel", off, true);
  const timer = window.setTimeout(off, 700);
}

/** The list's title and padding, one row, and a footer line, in px: its height before it renders. */
const MENU_CHROME_PX = 52;
const ROW_PX = 56;
const FOOTER_PX = 52;
const MENU_MIN_PX = 160;

/**
 * NYM's SourcePill (flat mode) and TokenPicker in the GreedyGoose kit: a pill in the amount card's top right that opens
 * a list anchored under it, inside the sheet. On open it measures the room in the sheet's scroll area (SourcePill's
 * openMenu) and flips up when the whole list doesn't fit below and there's more room above (NYM stops at 300px; a long
 * To list then showed three rows under the To card). Its height is capped to that room, so it never runs off the sheet,
 * and it scrolls inside. A row sets the asset; a tap away closes the list (useClickAway). Open/closed belongs to the
 * sheet, so Escape closes the list first. Keys: the list takes focus on the picked row, ↑ ↓ Home End move between the
 * rows that can be picked, and once the list closes focus goes back to the pill. Repay's "Pay with" adds a column
 * label beside the title (`titleAside`), a pill on each row (`aside`), one line under the list (`footer`), a list as
 * wide as the sheet's content (`wide`: its pill sits at the content's right edge), and a list that, when it has to
 * scroll, stops halfway through a row (`peek`), so it reads as one that scrolls.
 */
export function AssetPicker({
  label,
  title,
  name,
  mark,
  rows,
  selected,
  open,
  onToggle,
  onClose,
  onPick,
  disabled,
  titleAside,
  footer,
  wide = false,
  peek = false,
}: {
  /** The pill's accessible name: "Trade from: Cash". */
  label: string;
  /** The list's title: "Trade from". */
  title: string;
  name: string;
  mark: ReactNode;
  rows: PickerRow[];
  selected: string;
  open: boolean;
  onToggle: () => void;
  /** A tap away closed the list; the event says where it landed. */
  onClose: (e: Event) => void;
  onPick: (id: string) => void;
  disabled?: boolean;
  /** Beside the list's title, on the right: a label for the rows' `aside` column. */
  titleAside?: ReactNode;
  /** Under the list, outside its scroll: one line about the rows. */
  footer?: ReactNode;
  /** As wide as the sheet's content (350px on a 390px phone), not 320px. */
  wide?: boolean;
  /** When the list has to scroll, show half of its last visible row. */
  peek?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [up, setUp] = useState(false);
  const [maxH, setMaxH] = useState<number>();
  useClickAway(ref, (e) => {
    if (!open) return;
    onClose(e);
    // A tap away inside the sheet only closes the list, as a native menu does. iOS closes it on touchstart, then sends
    // the tap's mousedown and click to whatever the list was covering or sat next to (measured on Repay: Max fired; on
    // the amount the keypad opened). The sheet's Close still closes the sheet; the dim is the sheet's own (onOpenChange).
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('[role="dialog"]') && !t.closest('[aria-label="Close"]')) swallowNextPress();
  });

  const options = () => [
    ...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not([aria-disabled="true"])') ?? []),
  ];
  const wasOpen = useRef(false);
  // As a listbox does: the open list has focus, on the picked row (or the first that can be picked). Once it closes
  // (a pick, Escape, a tap away), focus that fell to the page goes back to the pill; focus a tap gave elsewhere stays.
  useEffect(() => {
    if (open) {
      const rowsNow = options();
      (rowsNow.find((o) => o.getAttribute("aria-selected") === "true") ?? rowsNow[0])?.focus({ preventScroll: true });
    } else if (wasOpen.current && (!document.activeElement || document.activeElement === document.body)) {
      pillRef.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);
  const onListKey = (e: KeyboardEvent) => {
    const rowsNow = options();
    const at = rowsNow.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      rowsNow[(i + rowsNow.length) % rowsNow.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? rowsNow.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rowsNow.length - 1);
  };

  /** Measure the room in the sheet's scroll area and place the list below or above the pill. */
  const place = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      const scroller = ref.current.closest("[data-sheet-scroll]");
      const box = scroller?.getBoundingClientRect();
      const top = box ? box.top : 0;
      const bottom = box ? box.bottom : (window.visualViewport?.height ?? window.innerHeight);
      // Clear of the scroll area's own bottom padding (the home indicator), as the sheet's content is.
      const pad = scroller ? parseFloat(getComputedStyle(scroller).paddingBottom) || 0 : 0;
      const below = bottom - r.bottom - Math.max(12, pad);
      const above = r.top - top - 12;
      const need = MENU_CHROME_PX + rows.length * ROW_PX + (footer ? FOOTER_PX : 0);
      const flip = below < need && above > below;
      setUp(flip);
      let h = Math.max(MENU_MIN_PX, flip ? above : below);
      if (peek && need > h) {
        const chrome = MENU_CHROME_PX + (footer ? FOOTER_PX : 0);
        h = chrome + (Math.max(1, Math.floor((h - chrome) / ROW_PX - 0.5)) + 0.5) * ROW_PX;
      }
      setMaxH(h);
    }
  };
  const toggle = () => {
    if (!open) place();
    onToggle();
  };
  // Opening the list from the amount field closes the keyboard, and the sheet drops and grows back right after the
  // list was placed for the short, lifted sheet: it opened upward over "You owe". Place it again once the keyboard is
  // gone (the visual viewport resizes as it goes).
  const placeRef = useRef(place);
  useEffect(() => {
    placeRef.current = place;
  });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!open || !vv) return;
    const again = () => placeRef.current();
    vv.addEventListener("resize", again);
    return () => vv.removeEventListener("resize", again);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={pillRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
        // 30px to the eye; the overlay takes the tap target to 44px.
        className="relative flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-[15px] bg-pill pl-1.5 pr-2 text-[13px] font-semibold leading-none text-ink transition after:absolute after:-inset-[7px] after:content-[''] active:scale-[0.97] disabled:opacity-45"
      >
        {mark}
        {name}
        <ChevronDown size={14} className="text-ink-mid" />
      </button>

      {open && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{ maxHeight: maxH }}
          className={`absolute right-0 z-30 flex ${wide ? "w-[min(350px,calc(100vw-40px))]" : "w-[min(320px,calc(100vw-40px))]"} flex-col rounded-[16px] border border-line-field bg-card p-2 shadow-[0_12px_32px_-12px_rgba(14,13,11,0.28)] animate-in fade-in-0 zoom-in-95 duration-150 ${
            up ? "bottom-full mb-2 origin-bottom-right" : "top-full mt-2 origin-top-right"
          }`}
        >
          {titleAside ? (
            <div className="flex shrink-0 items-center justify-between px-2 pb-2 pt-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
              <span>{title}</span>
              {titleAside}
            </div>
          ) : (
            <div className="shrink-0 px-2 pb-2 pt-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
              {title}
            </div>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={title}
            onKeyDown={onListKey}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain"
          >
            {rows.map((row) => {
              const on = row.id === selected;
              return (
                <button
                  key={row.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  aria-disabled={row.disabled || undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!row.disabled) onPick(row.id);
                  }}
                  className={`flex min-h-[52px] w-full shrink-0 items-center gap-3 rounded-[12px] px-2 py-2.5 text-left leading-[normal] transition ${
                    row.disabled ? "cursor-default opacity-50" : on ? "bg-pill" : "hover:bg-pill active:bg-pill-strong"
                  }`}
                >
                  {row.mark}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-semibold text-ink">{row.name}</span>
                    {row.sub && <span className="num text-[12px] leading-[1.3] text-ink-mid">{row.sub}</span>}
                  </span>
                  {row.right && (
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="num text-[14px] font-semibold text-ink">{row.right}</span>
                      {row.rightSub && <span className="text-[12px] text-subtle">{row.rightSub}</span>}
                    </span>
                  )}
                  {row.aside && <span className="shrink-0">{row.aside}</span>}
                  {on ? (
                    <span
                      aria-hidden
                      className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand shadow-[0_0_0_1.5px_#0e0d0b]"
                    >
                      <span className="size-2 rounded-full bg-ink" />
                    </span>
                  ) : (
                    <span aria-hidden className="size-[22px] shrink-0 rounded-full border-[1.5px] border-[#d9d2c3]" />
                  )}
                </button>
              );
            })}
          </div>
          {footer && <div className="mt-1 shrink-0 border-t border-hairline px-2 pb-1 pt-2.5">{footer}</div>}
        </div>
      )}
    </div>
  );
}

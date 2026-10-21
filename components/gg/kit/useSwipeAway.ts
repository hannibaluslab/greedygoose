"use client";

import { useRef, type DragEvent, type PointerEvent } from "react";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Swipe a card left to remove it (Adrian, 2026-10-21, Multi trade's rows). The card follows the finger leftwards and
 * the strip behind it (`strip`, red with Remove) grows into the space it leaves, never under the card, so a see-through
 * dark card shows no red. Past a third of the card, or a quick flick, the card slides out, its row closes up, then
 * `onRemove`; short of that it springs back. A move that starts up or down stays a scroll (the card is `touch-action:
 * pan-y`), and a tap stays a tap (`onTap`), never the click a swipe ends with. Moves the elements with inline styles,
 * as the sheet's drag-to-close does (SheetShell). Spread `row`, `strip` and `card` on the three elements.
 */
export function useSwipeAway({
  onRemove,
  onTap,
  disabled = false,
}: {
  onRemove: () => void;
  onTap: () => void;
  disabled?: boolean;
}) {
  const row = useRef<HTMLLIElement>(null);
  const card = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ id: number; x0: number; y0: number; t0: number; dx: number; swiping: boolean } | null>(null);
  const swiped = useRef(false);

  /** The card `dx` to the left (≤ 0) and the strip as wide as the gap, over `ms` (0: follow the finger). */
  const place = (dx: number, ms = 0) => {
    if (card.current) {
      card.current.style.transition = ms ? `translate ${ms}ms ${EASE}` : "none";
      card.current.style.translate = `${dx}px 0`;
    }
    if (strip.current) {
      strip.current.style.transition = ms ? `width ${ms}ms ${EASE}` : "none";
      strip.current.style.width = `${-dx}px`;
    }
  };
  /** Out to the left, then the row closes up (the list's 8px gap with it), then it goes. */
  const away = (width: number) => {
    place(-width, 200);
    window.setTimeout(() => {
      const li = row.current;
      if (li) {
        li.style.height = `${li.offsetHeight}px`;
        li.style.overflow = "hidden";
        void li.offsetHeight;
        li.style.transition = "height 180ms ease, margin 180ms ease, opacity 180ms ease";
        li.style.height = "0px";
        li.style.marginBottom = "-8px";
        li.style.opacity = "0";
      }
      window.setTimeout(onRemove, 180);
    }, 200);
  };

  const cardHandlers = {
    onClick: () => {
      if (swiped.current) swiped.current = false;
      else onTap();
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      swiped.current = false;
      if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
      drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), dx: 0, swiping: false };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (!d.swiping) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Up, down or rightwards first: not a swipe away.
        if (Math.abs(dx) <= Math.abs(dy) || dx > 0) {
          drag.current = null;
          return;
        }
        d.swiping = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      d.dx = Math.min(0, dx);
      place(d.dx);
    },
    onPointerUp: () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.swiping) return;
      swiped.current = true;
      const width = card.current?.offsetWidth ?? 1;
      const speed = -d.dx / Math.max(1, performance.now() - d.t0);
      if (-d.dx > width / 3 || (speed > 0.6 && -d.dx > 40)) away(width);
      else place(0, 220);
    },
    // A mouse drag over a logo would start the browser's own image drag (and cancel the swipe).
    onDragStart: (e: DragEvent<HTMLElement>) => e.preventDefault(),
    onPointerCancel: () => {
      const d = drag.current;
      drag.current = null;
      if (d?.swiping) place(0, 220);
    },
  };

  return {
    row: { ref: row },
    strip: { ref: strip },
    card: { ref: card, ...cardHandlers },
  };
}

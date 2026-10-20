"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowLeftIcon, CloseIcon } from "@/components/gg/kit/icons";
import { GooseLoader } from "@/components/gg/kit/GooseLoader";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { useBodyScrollLock, useKeyboardLift } from "@/hooks/useSheetViewport";

type SheetShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** When set, a back arrow renders to the LEFT of the title (Close stays on
   *  the right). Pass this ONLY when the sheet was reached as a step in a
   *  sequence — back returns to the previous sheet, Close dismisses the flow.
   *  Omit it and there's no arrow, so a standalone-opened sheet shows just
   *  Close (matches Apple HIG: back for hierarchy, close for a leaf). */
  onBack?: () => void;
  /** Optional element rendered inline, immediately after the title (e.g. a
   *  network selector). Sits in the left title cluster, not the right. */
  titleAccessory?: ReactNode;
  /** Optional element rendered to the left of the close button. */
  headerRight?: ReactNode;
  /** Hide the Close (X) button. For a sheet showing a nested step that is
   *  only meant to be left via Back, so the one-way hierarchy isn't
   *  short-circuited by an X that dismisses the whole flow. */
  hideClose?: boolean;
  /** Cap on the sheet's height, as a percent of viewport height. Only pass a
   *  value for a flow that deliberately wants a different ceiling; a lower
   *  default here would silently shrink every other sheet in the app. */
  maxHeightVh?: number;
  /** Keep the sheet's top at most this many px below the top of the viewport, so a short list
   *  still opens tall (F1-3's Market sheet starts at 188px). Content taller than that grows the
   *  sheet up to `maxHeightVh` as usual. */
  topPx?: number;
  /** Lock the scroll area to an exact pixel height — both floor and
   *  ceiling. For flows that keep one continuous sheet height across steps:
   *  the caller measures the reference step's scroll area on the way out and
   *  passes it here, so later steps neither shrink nor grow the sheet.
   *  Content taller than the lock scrolls inside as usual. */
  contentHeightPx?: number;
  /** Drop the scroll area's own bottom padding. For flows whose steps pin
   *  sticky CTAs at the very edge (the CTA then carries the safe-area inset):
   *  the padding held the pinned button short of the sheet bottom AND let the
   *  content scrolling beneath peek through that strip. */
  flushBottom?: boolean;
  /** "info" is the canvas's read-only sheet (HomeInfo, HomeCreditSlide): a
   *  24px title, the description as a 15px lead, and no Close: the sheet ends
   *  in its own buttons, and a tap outside or Escape closes it. 18px between
   *  parts with a lead, 16px without. */
  look?: "flow" | "info";
  /** A change made from this sheet is confirming on Base: the whole body waits (SheetConfirming). A TxButton inside
   *  says so on its own (useSheetConfirming); this is for a sheet whose buttons are its own. */
  confirming?: boolean;
  children: ReactNode;
};

/**
 * Set inside a host sheet's `<SheetSteps>` — tells any SheetShell rendered
 * below it to contribute only its body, because the host already owns the
 * drawer, the header and the scroll area.
 */
const SheetHostContext = createContext(false);

/**
 * The host drawer's count of changes confirming on Base. Each one adds itself while it confirms and takes itself off
 * after, so a sheet with several buttons waits while any of them does.
 */
const SheetConfirmingContext = createContext<(() => () => void) | null>(null);

/**
 * Whether a sheet waits on Base: `confirming` (the sheet's own say), or any change inside it that added itself (`add`,
 * through SheetConfirmingContext) and hasn't taken itself off yet. A step (`embedded`) draws no wait of its own: its
 * `confirming` goes to the host, which does.
 */
function useSheetWait(confirming: boolean, embedded: boolean) {
  const [count, setCount] = useState(0);
  const add = useCallback(() => {
    setCount((n) => n + 1);
    return () => setCount((n) => n - 1);
  }, []);
  useSheetConfirming(confirming && embedded);
  return { waits: !embedded && (confirming || count > 0), add };
}

/**
 * While the body is inert, focus leaves the sheet, and a step that took its place as the wait ended couldn't take focus
 * (SheetSteps tried while it was still inert). So when the wait ends, the step on screen takes focus, and is announced.
 */
function useFocusAfterWait(waits: boolean, scroll: React.RefObject<HTMLDivElement | null>) {
  const was = useRef(waits);
  useEffect(() => {
    if (was.current && !waits)
      scroll.current?.querySelector<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true });
    was.current = waits;
  }, [waits, scroll]);
}

/**
 * Once JAW's sheet hands back, the change confirms on Base: the whole sheet shows it, not only the button (Adrian,
 * 2026-10-21). Call it where the button is; outside a sheet (a page) it does nothing.
 */
export function useSheetConfirming(on: boolean) {
  const add = useContext(SheetConfirmingContext);
  useEffect(() => (on && add ? add() : undefined), [on, add]);
}

/**
 * Step container for a multi-step flow that lives in ONE drawer.
 *
 * Closing one drawer, waiting out its exit animation, then opening the next
 * made every hop a slide-down plus a slide-up, so a four-step sequence read
 * as eight moves. Wrapping the steps here instead keeps a single drawer on
 * screen and swaps its body: the incoming step slides in over ~200ms and
 * nothing leaves the screen. The child sheets are unchanged — each still
 * renders its own `SheetShell`, which detects the host through context and
 * returns just its children, so every sheet keeps working standalone.
 *
 * `stepKey` remounts the body on each step (fresh state per step, and the
 * enter animation replays); `direction` picks push vs pop so back reads as
 * back. The host supplies the title and the back arrow.
 */
export function SheetSteps({
  stepKey,
  direction = "forward",
  className = "",
  children,
}: {
  stepKey: string;
  direction?: "forward" | "back";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The scroll area belongs to the HOST and survives step changes, so a step
  // entered from a scrolled one opened mid-content. Focus needs moving for the
  // same reason: the element that had it just unmounted, so it fell to <body>
  // and the new step was never announced.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.closest("[data-sheet-scroll]")?.scrollTo({ top: 0 });
    el.focus({ preventScroll: true });
  }, [stepKey]);

  return (
    <SheetHostContext.Provider value={true}>
      <div
        key={stepKey}
        ref={ref}
        // -1: focusable programmatically for the announce above, never a tab
        // stop of its own.
        tabIndex={-1}
        className={`outline-none ${direction === "back" ? "sheet-step-back" : "sheet-step-fwd"} ${className}`}
      >
        {children}
      </div>
    </SheetHostContext.Provider>
  );
}

/**
 * Chrome for every bottom sheet: vaul drawer on the phone column (NYM's
 * SheetShell, phone branch only), styled from the GreedyGoo canvas.
 */
export function SheetShell({
  open,
  onOpenChange,
  title,
  description,
  onBack,
  titleAccessory,
  headerRight,
  hideClose = false,
  maxHeightVh = 88,
  topPx,
  contentHeightPx,
  flushBottom = false,
  look = "flow",
  confirming = false,
  children,
}: SheetShellProps) {
  const info = look === "info";
  // Inside a host flow this sheet is a step, not a drawer (see SheetSteps).
  const embedded = useContext(SheetHostContext);
  // Body lock + keyboard lift are a UNIT (see useSheetViewport) — the lift
  // math is only deterministic because the lock stops iOS panning the
  // document on input focus. Both are behavior-frozen: every branch encodes
  // a real-iOS failure that headless WebKit cannot reproduce. A step skips
  // both: the host's own shell already holds the single lock and the single
  // lift target, which is the point — two drawers meant two of each.
  useBodyScrollLock(open && !embedded);
  useKeyboardLift(open && !embedded);
  const dragToClose = useDragToClose(() => onOpenChange(false));
  const { waits, add } = useSheetWait(confirming, embedded);
  const scroll = useRef<HTMLDivElement>(null);
  useFocusAfterWait(waits, scroll);

  // As a step: contribute the body only. The host owns the drawer, the
  // header (title / back / close) and the scroll area, so the chrome props
  // are the host's to set and are ignored here.
  if (embedded) return open ? <>{children}</> : null;

  return (
    <>
      {/* Our own dim + tap-outside-to-close: non-modal vaul (below) skips
          its overlay along with its scroll lock. z-40 sits under the drawer
          (z-50), above the page, so it is what keeps taps off the page while
          a sheet is open (the Radix dialog is non-modal, DrawerContent). */}
      {open && (
        <div
          aria-hidden
          onClick={() => onOpenChange(false)}
          className="pointer-events-auto fixed inset-0 z-40 mx-auto max-w-[430px] bg-[rgba(14,13,11,0.45)] animate-in fade-in-0 duration-300"
        />
      )}
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        dismissible={false}
        // Keyboard handling is ours (useKeyboardLift) — vaul's own
        // `repositionInputs` re-measures the already-lifted drawer on every
        // visualViewport event and compounds, ballooning the sheet whenever
        // focus moves between inputs with the keyboard up.
        repositionInputs={false}
        // Scroll locking is ours too (useBodyScrollLock). vaul's modal mode
        // mounts react-remove-scroll, which preventDefaults touchmove on
        // everything OUTSIDE the drawer subtree — including portaled popovers
        // (a picker's list could not touch-scroll on iOS at all).
        modal={false}
      >
        <DrawerContent
          open={open}
          // The cap is a class reading a variable, not an inline max-height: useKeyboardLift clears the drawer's
          // inline max-height whenever no keyboard is up, which left a sheet taller than the screen running off its top.
          className="max-h-(--sheet-max-h)"
          style={
            {
              "--sheet-max-h": `${maxHeightVh}dvh`,
              minHeight: topPx ? `calc(100dvh - ${topPx}px)` : undefined,
            } as CSSProperties
          }
          // dismissible={false} also makes vaul ignore Escape, so close here.
          onEscapeKeyDown={() => onOpenChange(false)}
        >
          {/* The top bar (grabber + title row) drags the sheet down to close it (Adrian). vaul's own drag stays off
              (dismissible={false}): it fought the keyboard lift, so the drag is ours and limited to this bar, never
              the scroll area or the fields. */}
          <div {...dragToClose} className="touch-none select-none">
            <div aria-hidden className="mx-auto mt-2.5 h-[5px] w-10 shrink-0 rounded-[3px] bg-line-strong" />
            {/* A flow header is top-aligned on a 32px title row, so Back and Close stay level with the title when a description sits under it. */}
            <div
              className={`flex gap-1.5 px-5 ${!info ? "items-start pb-3 pt-4" : description ? "items-center py-[18px]" : "items-center py-4"}`}
            >
              {onBack && (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={onBack}
                  className="-ml-1.5 grid size-8 shrink-0 place-items-center rounded-full text-ink transition hover:bg-pill touch:active:scale-95"
                >
                  <ArrowLeftIcon />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className={`flex min-w-0 items-center gap-2 ${info ? "" : "min-h-8"}`}>
                  <DrawerTitle
                    className={`m-0 shrink-0 font-semibold tracking-tight-2 text-ink ${info ? "text-[24px] leading-[normal]" : "text-[20px]"}`}
                  >
                    {title}
                  </DrawerTitle>
                  {titleAccessory}
                </div>
                {description && (
                  // Flow, F1-3: 8px under the title, 16px above the content (the header's 12px plus 4).
                  <DrawerDescription
                    className={
                      info
                        ? "m-0 mt-2 text-[15px] leading-body text-ink-2"
                        : "mb-1 mt-2 text-body-xs leading-[1.4] text-ink-mid"
                    }
                  >
                    {description}
                  </DrawerDescription>
                )}
              </div>
              {headerRight}
              {!hideClose && !info && (
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => onOpenChange(false)}
                  className="ml-1 grid size-8 shrink-0 place-items-center rounded-full bg-[rgba(15,14,11,0.06)] text-ink transition hover:bg-pill-strong touch:active:scale-95"
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          </div>
          <div
            ref={scroll}
            data-sheet-scroll
            inert={waits}
            aria-busy={waits}
            className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-5 ${flushBottom ? "" : "pb-[max(34px,env(safe-area-inset-bottom))]"}`}
            // flex none while locked: `flex-1` would let the drawer's layout
            // renegotiate the height the lock is meant to pin.
            style={contentHeightPx ? { height: contentHeightPx, flex: "0 0 auto" } : undefined}
          >
            <SheetConfirmingContext.Provider value={add}>{children}</SheetConfirmingContext.Provider>
          </div>
          {waits && <SheetConfirming scroll={scroll} />}
        </DrawerContent>
      </Drawer>
    </>
  );
}

/**
 * The sheet while its change confirms on Base: over the body (the header's Close still works), the content fades
 * behind a veil, the goose walks it off, and one line says what it waits for. Placed on the scroll area as it is now, and again if it resizes.
 */
function SheetConfirming({ scroll }: { scroll: React.RefObject<HTMLDivElement | null> }) {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const place = () => setBox({ top: el.offsetTop, height: el.offsetHeight });
    place();
    const seen = new ResizeObserver(place);
    seen.observe(el);
    return () => seen.disconnect();
  }, [scroll]);
  if (!box) return null;
  return (
    <div
      role="status"
      className="absolute inset-x-0 z-10 flex flex-col items-center justify-center gap-4 bg-sheet/85 backdrop-blur-[2px] animate-in fade-in-0 duration-200"
      style={box}
    >
      {/* The goose walks it off while Base confirms (Adrian, 2026-10-21: "something cool and fun"). */}
      <GooseLoader mode="walk" className="h-[72px] w-[210px]" />
      <span className="text-[15px] font-semibold text-ink">Confirming on Base…</span>
    </div>
  );
}

/**
 * Drag the sheet down by its top bar to close it: past 90px, or a quick flick, it slides away and closes; otherwise it
 * springs back. A tap (under 6px of movement) stays a tap, so Back and Close still work. Moves the drawer element
 * itself (vaul's [data-vaul-drawer]) with an inline transform, cleared once it settles.
 */
function useDragToClose(close: () => void) {
  const drag = useRef<{ id: number; y0: number; t0: number; el: HTMLElement; dy: number; moving: boolean } | null>(
    null,
  );
  const settle = (el: HTMLElement, to: string, then?: () => void) => {
    el.style.transition = "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)";
    el.style.transform = to;
    window.setTimeout(() => {
      then?.();
      window.setTimeout(
        () => {
          el.style.transition = "";
          el.style.transform = "";
        },
        then ? 400 : 0,
      );
    }, 220);
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      const el = e.currentTarget.closest<HTMLElement>("[data-vaul-drawer]");
      if (!el || (e.pointerType === "mouse" && e.button !== 0)) return;
      drag.current = { id: e.pointerId, y0: e.clientY, t0: performance.now(), el, dy: 0, moving: false };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      d.dy = Math.max(0, e.clientY - d.y0);
      if (!d.moving && d.dy < 6) return;
      if (!d.moving) {
        d.moving = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        d.el.style.transition = "none";
      }
      d.el.style.transform = `translate3d(0, ${d.dy}px, 0)`;
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      if (!d || !d.moving) return;
      e.preventDefault();
      const speed = d.dy / Math.max(1, performance.now() - d.t0);
      if (d.dy > 90 || speed > 0.6) settle(d.el, "translate3d(0, 100%, 0)", close);
      else settle(d.el, "translate3d(0, 0, 0)");
    },
    onPointerCancel: () => {
      const d = drag.current;
      drag.current = null;
      if (d?.moving) settle(d.el, "translate3d(0, 0, 0)");
    },
    // A drag that ends on Back or Close mustn't also press it.
    onClickCapture: (e: React.MouseEvent) => {
      if (drag.current?.moving) e.stopPropagation();
    },
  };
}

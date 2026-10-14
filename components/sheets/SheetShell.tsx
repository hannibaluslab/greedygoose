"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { ArrowLeftIcon, CloseIcon } from "@/components/gg/icons";
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
  children: ReactNode;
};

/**
 * Set inside a host sheet's `<SheetSteps>` — tells any SheetShell rendered
 * below it to contribute only its body, because the host already owns the
 * drawer, the header and the scroll area.
 */
const SheetHostContext = createContext(false);

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
 * SheetShell, phone branch only), styled from the GreedyGoose canvas.
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
  children,
}: SheetShellProps) {
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

  // As a step: contribute the body only. The host owns the drawer, the
  // header (title / back / close) and the scroll area, so the chrome props
  // are the host's to set and are ignored here.
  if (embedded) return open ? <>{children}</> : null;

  return (
    <>
      {/* Our own dim + tap-outside-to-close: non-modal vaul (below) skips
          its overlay along with its scroll lock. z-40 sits under the drawer
          (z-50), above the page. pointer-events-auto: vaul still opens Radix's
          dialog as modal, which sets body { pointer-events: none } while the
          sheet is open, and vaul only resets that for uncontrolled opens. */}
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
          style={{ maxHeight: `${maxHeightVh}dvh`, minHeight: topPx ? `calc(100dvh - ${topPx}px)` : undefined }}
          // dismissible={false} also makes vaul ignore Escape, so close here.
          onEscapeKeyDown={() => onOpenChange(false)}
        >
          {/* The canvas draws a grabber; the sheet doesn't drag (dismissible={false}), so it's decoration only. */}
          <div aria-hidden className="mx-auto mt-2.5 h-[5px] w-10 shrink-0 rounded-[3px] bg-line-strong" />
          {/* Top-aligned on a 32px title row, so Back and Close stay level with the title when a description sits under it. */}
          <div className="flex items-start gap-1.5 px-5 pb-3 pt-4">
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
              <div className="flex min-h-8 min-w-0 items-center gap-2">
                <DrawerTitle className="m-0 shrink-0 text-[20px] font-semibold tracking-tight-2 text-ink">{title}</DrawerTitle>
                {titleAccessory}
              </div>
              {description && (
                // F1-3: 8px under the title, 16px above the content (the header's 12px plus 4).
                <DrawerDescription className="mb-1 mt-2 text-body-xs leading-[1.4] text-ink-mid">{description}</DrawerDescription>
              )}
            </div>
            {headerRight}
            {!hideClose && (
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
          <div
            data-sheet-scroll
            className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-5 ${flushBottom ? "" : "pb-[max(34px,env(safe-area-inset-bottom))]"}`}
            // flex none while locked: `flex-1` would let the drawer's layout
            // renegotiate the height the lock is meant to pin.
            style={contentHeightPx ? { height: contentHeightPx, flex: "0 0 auto" } : undefined}
          >
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

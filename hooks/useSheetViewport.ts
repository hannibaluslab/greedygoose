"use client";

import { useEffect } from "react";

/**
 * Mobile-sheet viewport management: body scroll lock + keyboard lift.
 *
 * These two hooks are a UNIT — the lift math is only deterministic because
 * the body lock stops iOS panning the document on input focus. Adopt them
 * together, and call both with the same `active` flag (open && mobile).
 * Every branch below encodes a failure observed on real iOS Safari; none
 * of it reproduces in desktop devtools or headless WebKit, so treat this
 * file as behavior-frozen unless you're verifying on a device.
 */

/**
 * Body scroll-lock while a mobile sheet is open.
 *
 * vaul ships this itself (`usePositionFixed`), but in 1.1.2 it's gated on an
 * internal `hasBeenOpened` flag that is ONLY set by Radix-initiated open
 * changes (trigger click, escape) — never by the controlled `open` prop we
 * use. So for our sheets vaul's iOS protections silently no-op, and on input
 * focus iOS Safari scrolls the document to "reveal" the input. While the
 * keyboard is open iOS treats `position: fixed` as absolute, so the whole
 * drawer rides up with that scroll: title crops off-screen and a sheet-
 * colored gap (the drawer's `::after`) opens between content and keyboard.
 *
 * Fixing the body to make the document unscrollable removes the thing iOS
 * pans, so the keyboard-lift effect below can place the drawer flush above
 * the keyboard deterministically. Refcounted because sheets can overlap
 * while one closes and the next opens.
 */
let bodyLockCount = 0;
let releaseBodyLock: (() => void) | null = null;

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    bodyLockCount++;
    if (bodyLockCount === 1) {
      const { body } = document;
      const scrollY = window.scrollY;
      const prev = {
        position: body.style.position,
        top: body.style.top,
        left: body.style.left,
        right: body.style.right,
        width: body.style.width,
      };
      body.style.setProperty("position", "fixed", "important");
      body.style.top = `${-scrollY}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      releaseBodyLock = () => {
        body.style.position = prev.position;
        body.style.top = prev.top;
        body.style.left = prev.left;
        body.style.right = prev.right;
        body.style.width = prev.width;
        window.scrollTo(0, scrollY);
      };
    }
    return () => {
      bodyLockCount--;
      if (bodyLockCount === 0) {
        releaseBodyLock?.();
        releaseBodyLock = null;
      }
    };
  }, [locked]);
}

/**
 * Keyboard lift, self-managed. vaul's own `repositionInputs` handler is
 * unusable here: it pins inline height/bottom from a re-*measured* drawer on
 * every visualViewport event, so whenever focus moves input → input with the
 * keyboard up it re-measures the already-lifted drawer and compounds — the
 * sheet balloons to fill everything above the keyboard, then keeps the stale
 * size after the keyboard closes. Instead we compute the lift from scratch
 * each event (bottom = keyboard overlap, maxHeight = visible height), so the
 * result is identical no matter how many times focus moves, and clear both
 * when the keyboard is gone. This only works because `useBodyScrollLock`
 * stops iOS panning the document on focus (the drawer's `position: fixed`
 * stays true); vaul still owns open/close transforms — we never touch those.
 *
 * Callers MUST pass `repositionInputs={false}` on the `Drawer`, or vaul's
 * handler fights this one.
 *
 * Separately: vaul's `modal` mode mounts react-remove-scroll, which
 * preventDefaults touchmove on everything OUTSIDE the drawer subtree —
 * including portaled popovers, whose lists then cannot be touch-scrolled on
 * iOS at all. That is a distinct bug from the lift and is NOT addressed here.
 */
export function useKeyboardLift(active: boolean) {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      const el = document.querySelector<HTMLElement>("[data-vaul-drawer]");
      if (!el) return;
      // The lift only engages while an editable is focused. Without this
      // gate, iOS Safari's dynamic toolbar (with viewport-fit=cover) makes
      // innerHeight and visualViewport.height disagree by ~100px with NO
      // keyboard — a phantom "overlap" that left every sheet permanently
      // lifted off the bottom edge, with the drawer's sheet-colored ::after
      // filling the gap below it.
      const ae = document.activeElement as HTMLElement | null;
      // SELECT counts: on iOS its picker wheel shrinks the visual viewport
      // exactly like the keyboard. Excluding it made the sheet drop ~300px
      // the instant focus moved input → select — the tap's target slid out
      // from under the finger (the "10 taps to hit the token pill" bug).
      // And only editables INSIDE the drawer lift it: a popover's search
      // field (country picker) is portaled outside — lifting the drawer
      // moved the popover's anchor mid-focus, so Radix re-flipped the
      // popover against the top edge and cropped the input being typed.
      const editing =
        !!ae &&
        el.contains(ae) &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.tagName === "SELECT" ||
          ae.isContentEditable);
      const overlap = editing
        ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        : 0;
      // <60px is keyboard-animation noise / accessory-bar shuffle, not an
      // open keyboard — treat as closed so the sheet rests at bottom: 0.
      if (overlap > 60) {
        el.style.bottom = `${overlap}px`;
        // 72px headroom keeps the sheet header clear of the iOS status bar
        // when the visible area is short (title stays readable while capped).
        el.style.maxHeight = `${vv.height - 72}px`;
      } else {
        el.style.bottom = "";
        el.style.maxHeight = "";
      }
    };
    // Focus moves don't fire visualViewport events by themselves — re-apply
    // on focus changes. Focus-IN applies on the next tick (so activeElement
    // reflects the new focus); focus-OUT waits a beat and is cancelled by a
    // quick refocus, so hopping input → select → input never bounces the
    // sheet down and back mid-tap. A real keyboard close still clears
    // immediately via the visualViewport resize event.
    let focusTimer: number | undefined;
    const onFocusIn = () => {
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(apply, 0);
    };
    const onFocusOut = () => {
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(apply, 250);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.clearTimeout(focusTimer);
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [active]);
}

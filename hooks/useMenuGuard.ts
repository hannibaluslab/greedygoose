"use client";

import { useRef, useState } from "react";

/** A tap on the dim that just closed a picker's list doesn't also close the sheet (the dim reports it after the list). */
const MENU_TAP_MS = 500;

/**
 * A sheet with a picker's list inside it (`menu`, `none` while closed). A tap away closes the list: only a tap on the
 * dim (outside the sheet) is swallowed, Close in the sheet still closes it. Escape, the dim and Close come to
 * `onOpenChange`: Escape with a list open closes the list; the dim's tap that just closed one closes nothing else; Close
 * closes the sheet (its press already closed the list).
 */
export function useMenuGuard<M>(onClose: () => void, none: M) {
  const [menu, setMenu] = useState<M>(none);
  const menuClosedAt = useRef(0);
  const closeMenu = (e?: Event) => {
    const inSheet = e?.target instanceof Element && !!e.target.closest('[role="dialog"]');
    if (!inSheet) menuClosedAt.current = Date.now();
    setMenu(none);
  };
  const onOpenChange = (next: boolean) => {
    if (next) return;
    if (menu !== none) return setMenu(none);
    if (Date.now() - menuClosedAt.current < MENU_TAP_MS) return;
    onClose();
  };
  return { menu, setMenu, closeMenu, onOpenChange };
}

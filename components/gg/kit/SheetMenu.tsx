"use client";

import { createContext, useContext } from "react";

/**
 * A sheet's open picker list (useMenuGuard), for a picker in a body the sheet holds only as a node (an agent's
 * settings): with the list open, Escape or a tap on the dim closes the list, not the sheet. Null outside such a sheet.
 */
export const SheetMenu = createContext<{
  menu: string | null;
  setMenu: (menu: string | null) => void;
  closeMenu: (e?: Event) => void;
} | null>(null);

export const useSheetMenu = () => useContext(SheetMenu);

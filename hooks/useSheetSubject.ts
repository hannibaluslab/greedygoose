"use client";

import { useEffect, useState } from "react";

/** vaul's open/close transition (TRANSITIONS.DURATION, 0.5s). */
const SHEET_EXIT_MS = 500;

/**
 * What a sheet is open for (a stock, a mode). The subject outlives `close()` until the drawer has
 * slid out, so the sheet leaves with its content, then drops to null so the closed sheet unmounts
 * and stops reading the chain. `key` changes on every `show()`: pass it as the sheet's React key so
 * each opening starts from a fresh amount and a fresh transaction.
 */
export function useSheetSubject<T>(initial: T | null = null) {
  const [subject, setSubject] = useState<T | null>(initial);
  const [open, setOpen] = useState(initial !== null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    if (open || subject === null) return;
    const id = setTimeout(() => setSubject(null), SHEET_EXIT_MS);
    return () => clearTimeout(id);
  }, [open, subject]);

  return {
    subject,
    open,
    key,
    show: (next: T) => {
      setSubject(next);
      setOpen(true);
      setKey((k) => k + 1);
    },
    close: () => setOpen(false),
  };
}

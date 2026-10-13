"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Bottom sheet used by Buy, Unlock and Credit: slides up, backdrop fades in,
 * Escape / backdrop tap closes, focus moves into the sheet, page behind stops scrolling.
 */
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 mx-auto max-w-[430px]">
      <button type="button" aria-label="Close" onClick={onClose} className="gg-backdrop absolute inset-0 bg-[rgba(14,13,11,0.45)]" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="gg-sheet absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col gap-3 overflow-y-auto rounded-t-[28px] bg-ground px-5 pb-[calc(34px+env(safe-area-inset-bottom))] pt-2.5 outline-none"
        style={{ boxShadow: "0 -16px 48px -16px rgba(0,0,0,0.35)" }}
      >
        <div aria-hidden className="h-[5px] w-10 shrink-0 self-center rounded-[3px] bg-[rgba(14,13,11,0.18)]" />
        {children}
      </div>
    </div>
  );
}

import type { ReactNode } from "react";

/** Primary action pinned to the bottom of long screens, over a fade, clear of the iPhone home bar. */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <>
      <div aria-hidden className="h-24 shrink-0" />
      <div
        className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[430px] flex-col gap-2 px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-6"
        style={{ background: "linear-gradient(to bottom, rgba(244,242,236,0), #f4f2ec 38%)" }}
      >
        {children}
      </div>
    </>
  );
}

"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { ActivityIcon, ChevronRight, GearIcon, GuideIcon, MenuIcon } from "./kit/icons";

const ITEMS = [
  { href: "/activity", label: "Activity", Icon: ActivityIcon },
  { href: "/guide", label: "Guide", Icon: GuideIcon },
  { href: "/settings", label: "Settings", Icon: GearIcon },
] as const;

/** What a screen puts in its menu besides the links: a card above them, and a dot on the button while it waits. */
export type MenuExtra = {
  /** Controlled open state, so the screen can prepare the card only while the menu shows. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Above the links (Home: "You received 120 USDT", Adrian 2026-10-20). */
  top?: ReactNode;
  /** How many things in the menu wait for the user: a number over the button while any does (0: none). */
  waiting?: number;
};

/**
 * The header menu (D16): Activity, the Guide and Settings live here, out of the tab bar, and on Home what waits for the
 * user (`extra`: other dollars to turn into cash), with how many over the button while any does (Adrian, 2026-10-20:
 * "a notification point or number over the burger menu icon when something is needed from the user").
 */
export function MenuButton({ extra }: { extra?: MenuExtra }) {
  const [own, setOwn] = useState(false);
  const open = extra?.open ?? own;
  const setOpen = extra?.onOpenChange ?? setOwn;
  const waiting = extra?.waiting ?? 0;
  return (
    <>
      <button
        type="button"
        aria-label={waiting > 0 ? `Menu, ${waiting} waiting for you` : "Menu"}
        onClick={() => setOpen(true)}
        className="relative -mr-2 flex size-10 items-center justify-center rounded-[20px] text-ink"
      >
        <MenuIcon />
        {waiting > 0 && (
          <span
            aria-hidden
            className="num absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-neg px-1 text-[11px] font-bold leading-none text-white"
          >
            {waiting > 9 ? "9+" : waiting}
          </span>
        )}
      </button>
      <SheetShell open={open} onOpenChange={setOpen} title="Menu">
        <SheetSteps stepKey="menu" className="flex flex-col gap-3.5">
          {extra?.top}
          <nav aria-label="Menu" className="rounded-[22px] bg-card px-4 py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
            {ITEMS.map(({ href, label, Icon }, i) => (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 py-3.5 text-[15px] font-semibold no-underline ${i ? "border-t border-hairline" : ""}`}
              >
                <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-chip text-ink">
                  <Icon size={18} />
                </span>
                <span className="flex-1">{label}</span>
                <ChevronRight className="text-subtle" />
              </Link>
            ))}
          </nav>
        </SheetSteps>
      </SheetShell>
    </>
  );
}

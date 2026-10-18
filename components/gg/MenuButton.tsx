"use client";

import Link from "next/link";
import { useState } from "react";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { ActivityIcon, ChevronRight, GearIcon, GuideIcon, MenuIcon } from "./icons";

const ITEMS = [
  { href: "/activity", label: "Activity", Icon: ActivityIcon },
  { href: "/guide", label: "Guide", Icon: GuideIcon },
  { href: "/settings", label: "Settings", Icon: GearIcon },
] as const;

/** The header menu (D16): Activity, the Guide and Settings live here, out of the tab bar. */
export function MenuButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Menu"
        onClick={() => setOpen(true)}
        className="-mr-2 flex size-10 items-center justify-center rounded-[20px] text-ink"
      >
        <MenuIcon />
      </button>
      <SheetShell open={open} onOpenChange={setOpen} title="Menu">
        <SheetSteps stepKey="menu">
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

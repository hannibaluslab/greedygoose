"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ActivityIcon, CreditIcon, GearIcon, HomeIcon, InvestIcon } from "./icons";

const TABS = [
  { href: "/home", label: "Home", Icon: HomeIcon },
  { href: "/portfolio", label: "Portfolio", Icon: InvestIcon },
  { href: "/credit", label: "Credit", Icon: CreditIcon },
  { href: "/activity", label: "Activity", Icon: ActivityIcon },
  { href: "/settings", label: "Settings", Icon: GearIcon },
] as const;

/** Floating dark pill tab bar with the fade behind it, as in the design. */
export function TabBar() {
  const path = usePathname();
  return (
    <>
      <div aria-hidden className="h-[104px]" />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 h-[120px]"
        style={{ background: "linear-gradient(to bottom, rgba(244,242,236,0), #f4f2ec 70%)" }}
      />
      <nav
        aria-label="Main"
        className="fixed bottom-6 left-1/2 grid h-14 w-[calc(min(100vw,430px)-28px)] -translate-x-1/2 rounded-[28px] px-1.5"
        style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0,1fr))`, background: "rgba(20,19,15,0.94)", boxShadow: "0 16px 48px -16px rgba(0,0,0,0.4)" }}
      >
        {TABS.map(({ href, label, Icon }) => {
          const active = path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-[3px] text-[10px] ${active ? "font-semibold text-on-ink" : "font-medium text-[rgba(245,240,226,0.55)]"}`}
            >
              <Icon />
              {label}
              {active && (
                <span aria-hidden className="absolute bottom-1 h-0.5 w-4 rounded-[1px] bg-brand" style={{ boxShadow: "0 0 12px rgba(212,255,60,0.5)" }} />
              )}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AgentsIcon, FriendsIcon, HomeIcon, InvestIcon, PayIcon } from "./icons";
import { FRIENDS_ENABLED } from "@/lib/features";

/** D16: Home / Invest / Agents / Friends / Pay. `match` lists the routes that light a tab. */
const TABS = [
  { href: "/home", label: "Home", Icon: HomeIcon, match: ["/home"] },
  { href: "/portfolio", label: "Invest", Icon: InvestIcon, match: ["/portfolio"] },
  { href: "/agents", label: "Agents", Icon: AgentsIcon, match: ["/agents", "/activity"] },
  ...(FRIENDS_ENABLED ? [{ href: "/friends", label: "Friends", Icon: FriendsIcon, match: ["/friends"] }] : []),
  { href: "/receive", label: "Pay", Icon: PayIcon, match: ["/receive"] },
];

/** Floating dark pill tab bar with the fade behind it, as in the design. The board's 24px under it sat over the home
 * indicator; in a Safari tab the page already ends above Safari's bar, so it floats 8px over the bottom inset. */
export function TabBar() {
  const path = usePathname();
  return (
    <>
      <div aria-hidden className="h-[calc(env(safe-area-inset-bottom)+88px)]" />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 h-[calc(env(safe-area-inset-bottom)+104px)]"
        style={{ background: "linear-gradient(to bottom, rgba(244,242,236,0), #f4f2ec 70%)" }}
      />
      <nav
        aria-label="Main"
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+8px)] left-1/2 grid h-14 w-[calc(min(100vw,430px)-28px)] -translate-x-1/2 rounded-[28px] px-1.5"
        style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0,1fr))`, background: "rgba(20,19,15,0.94)", boxShadow: "0 16px 48px -16px rgba(0,0,0,0.4)" }}
      >
        {TABS.map(({ href, label, Icon, match }) => {
          const active = match.some((m) => path.startsWith(m));
          // Agents, the middle tab, is a lime button docked in the bar (Adrian: yellow, round, bigger, higher). Done the
          // way docked centre buttons are: raised half out of the bar, a ring in the page's colour so it sits in a
          // notch rather than on top of the bar, a soft shadow instead of a glow, and its label on the same line as
          // the other tabs'.
          if (href === "/agents") {
            return (
              <Link key={href} href={href} aria-current={active ? "page" : undefined} className="relative flex flex-col items-center justify-end pb-[9px]">
                <span className="absolute left-1/2 top-0 grid size-[52px] -translate-x-1/2 -translate-y-[22px] place-items-center rounded-full bg-brand text-ink shadow-[0_6px_14px_-4px_rgba(14,13,11,0.35)] ring-[5px] ring-ground transition active:scale-95">
                  <Icon size={24} />
                </span>
                <span className={`text-[10px] font-medium tracking-tight ${active ? "text-on-ink" : "text-[rgba(245,240,226,0.45)]"}`}>{label}</span>
              </Link>
            );
          }
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              // One accent only, the lime button: the tab you're on is full cream, the others cream at 45% (the booth's dimming).
              className={`flex flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-tight transition ${active ? "text-on-ink" : "text-[rgba(245,240,226,0.45)]"}`}
            >
              <Icon />
              {label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

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
          // Agents is the round lime button in the middle, 56px and raised 16px over the bar (Adrian): the agents are what
          // the app runs on.
          if (href === "/agents") {
            return (
              <Link key={href} href={href} aria-label={label} aria-current={active ? "page" : undefined} className="flex items-center justify-center">
                {/* The booth app's centre button (jaw-hackathon-booth TabBar): 56px lime, raised, a 24px lime glow. */}
                <span className="grid size-14 -translate-y-5 place-items-center rounded-full bg-brand text-ink shadow-[0_0_24px_rgba(212,255,60,0.4)] transition active:scale-95">
                  <Icon size={24} />
                </span>
              </Link>
            );
          }
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              // The booth's tabs: the one you're on in lime, the others cream at 45%.
              className={`flex flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-tight transition ${active ? "text-brand" : "text-[rgba(245,240,226,0.45)]"}`}
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

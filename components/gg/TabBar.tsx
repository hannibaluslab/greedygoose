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

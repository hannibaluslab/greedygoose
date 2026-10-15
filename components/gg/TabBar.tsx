"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AgentsIcon, FriendsIcon, HomeIcon, InvestIcon, PayIcon } from "./icons";
import { FRIENDS_ENABLED } from "@/lib/features";

/**
 * D16's five tabs, in the booth app's tab bar style (Adrian, 2026-10-15): Home sits in the middle, raised, as the
 * booth has it, since it's where everyone goes back to; Invest and Agents on its left, Friends and Pay on its right.
 * `match` lists the routes that light a tab.
 */
const SIDE = [
  { href: "/portfolio", label: "Invest", Icon: InvestIcon, match: ["/portfolio"] },
  { href: "/agents", label: "Agents", Icon: AgentsIcon, match: ["/agents", "/activity"] },
];
const RIGHT = [
  ...(FRIENDS_ENABLED ? [{ href: "/friends", label: "Friends", Icon: FriendsIcon, match: ["/friends"] }] : []),
  { href: "/receive", label: "Pay", Icon: PayIcon, match: ["/receive"] },
];
const HOME = { href: "/home", label: "Home", Icon: HomeIcon, match: ["/home"] };

/**
 * The booth app's tab bar (jaw-hackathon-booth, components/ui.tsx): fixed to the bottom edge, full width, ink at 90%
 * with a blur and a hairline on top; the tab you're on in lime, the others cream at 45%; Home a raised lime circle.
 * Fixed, so screens keep room for it with the spacer below.
 */
export function TabBar() {
  const path = usePathname();
  const homeOn = HOME.match.some((m) => path.startsWith(m));
  const tab = ({ href, label, Icon, match }: (typeof SIDE)[number]) => {
    const on = match.some((m) => path.startsWith(m));
    return (
      <li key={href} className="flex-1">
        <Link
          href={href}
          aria-current={on ? "page" : undefined}
          className={`flex h-full flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-tight no-underline transition ${on ? "text-brand" : "text-[rgba(245,240,226,0.45)]"}`}
        >
          <Icon />
          {label}
        </Link>
      </li>
    );
  };
  return (
    <>
      <div aria-hidden className="h-[calc(env(safe-area-inset-bottom)+96px)]" />
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[rgba(255,255,255,0.1)] bg-ink/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
      >
        <ul className="m-0 mx-auto flex h-16 w-full max-w-[430px] list-none items-stretch justify-around px-2 py-0">
          {SIDE.map(tab)}
          <li className="flex flex-1 items-center justify-center">
            <Link
              href={HOME.href}
              aria-label={HOME.label}
              aria-current={homeOn ? "page" : undefined}
              className="-mt-6 grid size-14 place-items-center rounded-full bg-brand text-ink shadow-[0_0_24px_rgba(212,255,60,0.4)] transition active:scale-95"
            >
              <HOME.Icon size={24} />
            </Link>
          </li>
          {RIGHT.map(tab)}
        </ul>
      </nav>
    </>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AgentsIcon, BoardIcon, HomeIcon, InvestIcon, SendIcon } from "./kit/icons";
import { LEADERBOARD_ENABLED } from "@/lib/features";

/**
 * D16: Home / Invest / Agents / Leaderboard / Send (Friends became the Leaderboard, and Send replaced Pay, 2026-10-15).
 * `match` lists the routes that light a tab. Receive (Top up) is a sheet over the page it opens from, so it lights none.
 */
const TABS = [
  { href: "/home", label: "Home", Icon: HomeIcon, match: ["/home"] },
  { href: "/portfolio", label: "Invest", Icon: InvestIcon, match: ["/portfolio"] },
  { href: "/agents", label: "Agents", Icon: AgentsIcon, match: ["/agents", "/activity"] },
  ...(LEADERBOARD_ENABLED
    ? [{ href: "/leaderboard", label: "Leaderboard", Icon: BoardIcon, match: ["/leaderboard"] }]
    : []),
  { href: "/send", label: "Send", Icon: SendIcon, match: ["/send"] },
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
        style={{ background: "linear-gradient(to bottom, transparent, var(--bg-app) 70%)" }}
      />
      <nav
        aria-label="Main"
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+8px)] left-1/2 grid h-14 w-[calc(min(100vw,430px)-28px)] -translate-x-1/2 rounded-[28px] px-1.5"
        style={{
          gridTemplateColumns: `repeat(${TABS.length}, minmax(0,1fr))`,
          background: "rgba(20,19,15,0.94)",
          boxShadow: "0 16px 48px -16px rgba(0,0,0,0.4)",
        }}
      >
        {TABS.map(({ href, label, Icon, match }) => {
          const active = match.some((m) => path.startsWith(m));
          // Agents, the middle tab, is a lime button docked in the bar (Adrian: yellow, round, bigger, higher). Done the
          // way docked centre buttons are: raised half out of the bar, a ring in the page's colour so it sits in a
          // notch rather than on top of the bar, a soft shadow instead of a glow.
          if (href === "/agents") {
            return (
              // No label under it (Adrian: the word looked odd there), as the booth's centre button; screen readers get it.
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className="relative flex items-center justify-center"
              >
                <span className="absolute left-1/2 top-0 grid size-[52px] -translate-x-1/2 -translate-y-[14px] place-items-center rounded-full bg-brand text-ink shadow-[0_6px_14px_-4px_rgba(14,13,11,0.35)] ring-[5px] ring-ground transition active:scale-95">
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

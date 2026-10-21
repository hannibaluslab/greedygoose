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

/**
 * Light: the floating dark pill tab bar with the fade behind it, as in the design (dark: BoothTabBar below). Lower
 * (Adrian, 2026-10-21): it reaches into the bottom inset, ending 20px from the edge on an iPhone with a home bar (the
 * bar's line stays clear under it), and 6px where there's no inset (a Safari tab, whose page already ends above
 * Safari's bar).
 */
export function TabBar() {
  const path = usePathname();
  return (
    <>
      {/* The room the bar takes: the pill's in light, the booth's (its <Screen tabs> pb-28) in dark. */}
      <div aria-hidden className="h-[calc(max(6px,env(safe-area-inset-bottom)-14px)+80px)] dark:h-28" />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 h-[calc(env(safe-area-inset-bottom)+104px)] dark:hidden"
        style={{ background: "linear-gradient(to bottom, transparent, var(--bg-app) 70%)" }}
      />
      <nav
        aria-label="Main"
        className="fixed bottom-[max(6px,calc(env(safe-area-inset-bottom)-14px))] left-1/2 grid h-14 w-[calc(min(100vw,430px)-28px)] -translate-x-1/2 rounded-[28px] px-1.5 dark:hidden"
        style={{
          gridTemplateColumns: `repeat(${TABS.length}, minmax(0,1fr))`,
          background: "rgba(20,19,15,0.94)",
          boxShadow: "0 16px 48px -16px rgba(0,0,0,0.4)",
        }}
      >
        {TABS.map(({ href, label, Icon, match }) => {
          const active = match.some((m) => path.startsWith(m));
          // Agents, the middle tab, is a lime button docked in the bar (Adrian: yellow, round, bigger). Done the way docked
          // centre buttons are: raised out of the bar (4px since 2026-10-22, so it clears Home's last cards), a ring in the
          // page's colour so it sits in a notch rather than on top of the bar, a soft shadow instead of a glow.
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
                <span className="absolute left-1/2 top-0 grid size-[52px] -translate-x-1/2 -translate-y-[4px] place-items-center rounded-full bg-brand text-ink shadow-[0_6px_14px_-4px_rgba(14,13,11,0.35)] ring-[5px] ring-ground transition active:scale-95">
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
      <BoothTabBar path={path} />
    </>
  );
}

/**
 * Dark: the booth's tab bar, exactly (Adrian, 2026-10-21: "same footer nav as jaw-booth-mainnet"; hannibaluslab/
 * jaw-booth-revamp src/components/ui.tsx TabBar), with GreedyGoo's own tabs and icons. Full width and fixed to the
 * bottom, the ground at 90% with a blur and a hairline on top; the middle tab a lime button raised out of it with
 * the booth's glow; the tab you're on in lime, the others cream at 45%. One change: the row is GreedyGoo's 430px
 * column, not the booth's 480, so a sheet's scrim (which covers that column) covers every tab. The booth's colours are
 * written out, since its `ink` is GreedyGoo's ground (here `ink` is the words' colour). No z-index, as the pill.
 * Shorter than the booth's 64px (Adrian, 2026-10-22: no empty band under the labels above Safari's bar): 52px, the
 * tabs sit 4px off its bottom, and the lime button stays centred on the icons, 10px out of the bar.
 */
function BoothTabBar({ path }: { path: string }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 hidden border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-xl dark:block"
      style={{ background: "rgba(14,13,11,0.9)", borderTopColor: "rgba(255,255,255,0.1)" }}
    >
      <ul className="mx-auto flex h-[52px] w-full max-w-[430px] items-stretch justify-around px-2">
        {TABS.map(({ href, label, Icon, match }) => {
          const active = match.some((m) => path.startsWith(m));
          if (href === "/agents") {
            return (
              <li key={href} className="flex flex-1 items-start justify-center">
                <Link
                  href={href}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  className="-mt-[10px] grid h-14 w-14 place-items-center rounded-full bg-brand text-ink transition active:scale-95"
                  // Inline, so the dark .bg-brand glow (0.3) doesn't replace the booth's own (0.4).
                  style={{ boxShadow: "0 0 24px rgba(212,255,60,0.4)" }}
                >
                  <Icon size={24} />
                </Link>
              </li>
            );
          }
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex h-full flex-col items-center justify-end gap-1 pb-1 transition ${active ? "text-brand" : "text-[rgba(245,240,226,0.45)] hover:text-[rgba(245,240,226,0.8)]"}`}
              >
                <Icon size={22} />
                <span className="text-[10px] font-medium tracking-tight">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

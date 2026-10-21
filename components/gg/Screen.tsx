import Link from "next/link";
import type { ReactNode } from "react";
import { BackIcon } from "./kit/icons";
import { MenuButton } from "./MenuButton";
import { StatusPill } from "./Status";
import { Tap } from "./kit/Tap";
import { STATUS_LABEL, type Status } from "@/lib/risk/status";

/**
 * Top of every screen but Home (PortfolioPage): the back chevron (Adrian: "all pages should have the back button like
 * portfolio page"; Home has none), the title, then on the right an optional action
 * (Send's Receive link), the credit status pill (a link or a button when given somewhere to go) and the header menu,
 * which Manage's boards leave out (`menu={false}`).
 */
export function TabHeader({
  title,
  back,
  action,
  status,
  statusHref,
  onStatus,
  menu = true,
}: {
  title: string;
  back?: string;
  action?: ReactNode;
  status?: Status;
  statusHref?: string;
  onStatus?: () => void;
  menu?: boolean;
}) {
  return (
    // Home's header band (Header.tsx, Adrian 2026-10-22: the same header on every page): stuck to the top across the
    // screen's 20px gutters, the ground at 80% with a blur and a hairline under it, the row at the page's top and 9px
    // of band under it. Screens using it start with no top padding of their own.
    <div className="sticky top-0 z-20 -mx-5 flex items-center justify-between border-b border-[rgba(14,13,11,0.1)] bg-[rgba(244,242,236,0.8)] px-5 pb-[9px] pt-[env(safe-area-inset-top)] leading-[normal] backdrop-blur-xl dark:border-[rgba(255,255,255,0.1)] dark:bg-[rgba(14,13,11,0.8)]">
      <div className="flex items-center">
        {back && (
          <Link href={back} aria-label="Back" className="-ml-3 -mr-1 flex size-11 items-center justify-center text-ink">
            <BackIcon />
          </Link>
        )}
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        {action}
        {status && (
          <Tap
            href={statusHref}
            onClick={onStatus}
            label={`Credit status: ${STATUS_LABEL[status]}`}
            className="flex h-8 items-center"
          >
            <StatusPill status={status} size="header" />
          </Tap>
        )}
        {menu && <MenuButton />}
      </div>
    </div>
  );
}

export function WhiteCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[22px] bg-card shadow-[0_1px_3px_rgba(14,13,11,0.06)] ${className}`}>{children}</div>;
}

export function Line({ label, value, first = false }: { label: ReactNode; value: ReactNode; first?: boolean }) {
  return (
    <div
      className={`num flex items-center justify-between py-[13px] text-[15px] ${first ? "" : "border-t border-hairline"}`}
    >
      <span className="text-ink-mid">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

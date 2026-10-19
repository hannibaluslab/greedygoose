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
    <div className="flex items-center justify-between leading-[normal]">
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

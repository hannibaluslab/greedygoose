import Link from "next/link";
import type { ReactNode } from "react";
import { BackIcon } from "./icons";
import { MenuButton } from "./MenuButton";

/** Sub-screen chrome from the design: back chevron, centred mono label, optional right slot. */
export function SubHeader({ label, right, back = "/home" }: { label: string; right?: ReactNode; back?: string }) {
  return (
    <div className="flex items-center justify-between">
      <Link href={back} aria-label="Back" className="-ml-3 flex size-11 items-center justify-center text-ink"><BackIcon /></Link>
      <span className="label">{label}</span>
      <div className="-mr-1 flex size-11 items-center justify-center">{right}</div>
    </div>
  );
}

/** Top of a tab screen: the title and the header menu. */
export function TabHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">{title}</h1>
      <MenuButton />
    </div>
  );
}

export function WhiteCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[22px] bg-card shadow-[0_1px_3px_rgba(14,13,11,0.06)] ${className}`}>{children}</div>;
}

export function Line({ label, value, first = false }: { label: ReactNode; value: ReactNode; first?: boolean }) {
  return (
    <div className={`num flex items-center justify-between py-[13px] text-[15px] ${first ? "" : "border-t border-hairline"}`}>
      <span className="text-ink-mid">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

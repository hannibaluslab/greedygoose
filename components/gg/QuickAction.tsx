import type { ReactNode } from "react";
import { Tap } from "./Tap";

/** A round dark action under the balance (HomeUpliftRail: Trade, Top up, Credit Buy, Repay); four sit in a row. */
export function QuickAction({
  label,
  icon,
  href,
  onClick,
  dim = false,
}: {
  label: string;
  icon: ReactNode;
  href?: string;
  onClick?: () => void;
  /** Nothing to do here right now (board 2g's fade): still tappable, to say why. */
  dim?: boolean;
}) {
  return (
    <Tap
      href={href}
      onClick={onClick}
      className={`flex flex-col items-center gap-[7px] leading-[normal] ${dim ? "opacity-60" : ""}`}
    >
      <span aria-hidden className="flex size-12 items-center justify-center rounded-3xl bg-ink text-on-ink">
        {icon}
      </span>
      <span className="text-center text-[12px] font-medium text-ink-2">{label}</span>
    </Tap>
  );
}

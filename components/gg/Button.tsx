import type { ReactNode } from "react";
import { Tap } from "./Tap";

/**
 * Pill buttons from the canvas:
 *   primary  lime, the one main action (HomeCreditSlide "Repay", PortfolioPage "Credit Buy")
 *   dark     ink (F1-4 "Review buy")
 *   soft     grey (HomeCreditSlide "Buy more", F2-6 "Back")
 *   white    card (PortfolioPage "Market")
 * md is the 52px sheet and card size; lg is the 56px CTA at the foot of a page (CreditOn).
 */
const VARIANT = {
  primary: "bg-brand font-bold text-ink shadow-brand-glow disabled:shadow-none",
  dark: "bg-ink font-semibold text-on-ink",
  soft: "bg-pill font-semibold text-ink",
  white: "bg-card font-semibold text-ink shadow-card-elev",
} as const;

const SIZE = {
  md: "h-[52px] gap-2 rounded-[26px] px-6 text-[15px]",
  lg: "h-14 gap-2.5 rounded-[28px] px-6 text-base",
} as const;

export type ButtonVariant = keyof typeof VARIANT;
export type ButtonSize = keyof typeof SIZE;

export const buttonClass = (variant: ButtonVariant, size: ButtonSize) =>
  `flex items-center justify-center disabled:opacity-45 ${VARIANT[variant]} ${SIZE[size]}`;

export function Button({
  variant = "primary", size = "md", icon, href, onClick, disabled, className = "", children,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 18px icon before the label (Market, Credit Buy). */
  icon?: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tap href={href} onClick={onClick} disabled={disabled} className={`${buttonClass(variant, size)} ${className}`}>
      {icon}
      {children}
    </Tap>
  );
}

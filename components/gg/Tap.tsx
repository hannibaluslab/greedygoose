import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

/**
 * One tappable surface for the kit's cards, chips and buttons: a link when it navigates (`href`),
 * a button when it opens something in place (`onClick`), plain when it does neither.
 * Children should be phrasing content (spans), since a button may not hold divs.
 */
export function Tap({
  href, onClick, disabled, className = "", style, label, children,
}: {
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Accessible name when the visible text alone doesn't say what the tap does (link or button only). */
  label?: string;
  children: ReactNode;
}) {
  if (href && !disabled) {
    return <Link href={href} aria-label={label} className={`no-underline ${className}`} style={style}>{children}</Link>;
  }
  if (onClick || disabled) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} aria-label={label} className={className} style={style}>
        {children}
      </button>
    );
  }
  return <span className={className} style={style}>{children}</span>;
}

/* Stroke icons copied from the GreedyGoose design canvas. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, sw: number, rest: SVGProps<SVGSVGElement>) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...rest,
});

export const MenuIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.8, r)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
export const InfoIcon = ({ size = 14, ...r }: P) => <svg {...base(size, 2, r)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
export const ChevronRight = ({ size = 14, ...r }: P) => <svg {...base(size, 2, r)}><path d="M9 6l6 6-6 6" /></svg>;
export const BackIcon = ({ size = 22, ...r }: P) => <svg {...base(size, 1.8, r)}><path d="M15 5l-7 7 7 7" /></svg>;
export const PlusIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.7, r)}><path d="M12 5v14M5 12h14" /></svg>;
export const ReceiveIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.7, r)}><path d="M12 4v12M6 10l6 6 6-6M5 20h14" /></svg>;
export const RepayIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.7, r)}><path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></svg>;
export const CreditIcon = ({ size = 20, ...r }: P) => (
  <svg {...base(size, 1.7, r)}>
    <path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17" />
    <path d="M7 21l1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9" />
    <path d="M2 16l6 6" /><circle cx="16" cy="9" r="2.9" /><circle cx="6" cy="5" r="3" />
  </svg>
);
export const LockIcon = ({ size = 8, ...r }: P) => (
  <svg width={size} height={size * 1.1} viewBox="0 0 10 11" aria-hidden {...r}>
    <rect x="1" y="4.6" width="8" height="5.6" rx="1.4" fill="currentColor" />
    <path d="M3 4.8V3.4a2 2 0 0 1 4 0v1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
export const UnlockIcon = ({ size = 8, ...r }: P) => (
  <svg width={size} height={size * 1.1} viewBox="0 0 10 11" aria-hidden {...r}>
    <rect x="1" y="4.6" width="8" height="5.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 4.8V3.4a2 2 0 0 1 3.9-.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
export const FaceIdIcon = ({ size = 20, ...r }: P) => (
  <svg {...base(size, 1.8, r)}><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1M15 9v1M12 9v4h-1M9 16c1.5 1 4.5 1 6 0" /></svg>
);
export const SlidersIcon = ({ size = 18, ...r }: P) => (
  <svg {...base(size, 1.8, r)}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
);
export const ShieldIcon = ({ size = 12, ...r }: P) => <svg {...base(size, 2.2, r)}><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" /></svg>;
export const HomeIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.7, r)}><path d="M4 11l8-7 8 7v9H4zM10 20v-5h4v5" /></svg>;
export const InvestIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.7, r)}><path d="M3 17l6-6 4 4 8-8M15 7h6v6" /></svg>;
export const GearIcon = ({ size = 20, ...r }: P) => (
  <svg {...base(size, 1.7, r)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const TradeIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.7, r)}><path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4" /></svg>;
export const ActivityIcon = ({ size = 20, ...r }: P) => <svg {...base(size, 1.7, r)}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>;

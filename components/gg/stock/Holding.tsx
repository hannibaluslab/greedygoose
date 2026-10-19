import type { ReactNode } from "react";
import { MoneyCompact } from "../Money";
import { Sparkline } from "../Sparkline";
import { StockAvatar } from "../StockAvatar";
import { Tap } from "../Tap";
import { BacksIcon, ChevronRight, FreeIcon, PlusIcon } from "../icons";
import { formatShares, formatSignedPct, formatUsd } from "@/lib/formatting";
import { wholePct } from "@/lib/holding";
import { LINE_POINTS, downsample } from "@/lib/prices/market";

/** Stocks earn no yield (D19): the holding pieces carry no APY. What a holding shows instead is how much of it backs credit. */
type HoldingProps = {
  symbol: string;
  name: string;
  valueUsd: number;
  /** Share of the holding that backs credit, 0–1. */
  backs: number;
  /** Today's change as a fraction, from market prices; hidden until known. */
  today?: number | null;
  /** Market prices over the last 24 hours, oldest first, drawn with as many points as the board; no line until there are two. */
  spark?: number[];
  href?: string;
  onClick?: () => void;
};

/**
 * "33% backs credit" or "Not backing credit". `compact` is the Home rail's small chip
 * (the figure and linked rings, or one empty ring when free; D17: no padlock); the words go to screen readers and the tooltip.
 */
function BacksChip({ backs, compact = false }: { backs: number; compact?: boolean }) {
  const words = backs > 0 ? `${wholePct(backs)}% backs credit` : "Not backing credit";
  if (compact) {
    return backs > 0 ? (
      <span
        title={words}
        className="num inline-flex h-4 items-center gap-[3px] whitespace-nowrap rounded-[8px] bg-ground pl-1.5 pr-[5px] text-[9.5px] font-semibold text-ink-2"
      >
        <span aria-hidden>{wholePct(backs)}%</span>
        <BacksIcon />
        <span className="sr-only">{words}</span>
      </span>
    ) : (
      <span
        title={words}
        className="inline-flex h-4 w-5 items-center justify-center rounded-[8px] border border-dashed border-[rgba(14,13,11,0.22)] text-subtle"
      >
        <FreeIcon />
        <span className="sr-only">{words}</span>
      </span>
    );
  }
  return backs > 0 ? (
    <span className="num inline-flex items-center gap-[5px] whitespace-nowrap rounded-full bg-ground px-[9px] py-1 text-[11.5px] leading-[1.2] text-ink-mid">
      <BacksIcon size={10} />
      {words}
    </span>
  ) : (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-dashed border-line-strong px-[9px] py-[3px] text-[11.5px] leading-[1.2] text-subtle">
      {words}
    </span>
  );
}

const toneOf = (today: number) => (formatSignedPct(today).startsWith("−") ? "neg" : "pos");

/** A holding on the Home rail (HomeUpliftRail): badge, name, value, today's move and its line. */
export function HoldingCard({
  symbol,
  name,
  valueUsd,
  backs,
  today,
  spark,
  pending,
  shares,
  href,
  onClick,
}: HoldingProps & {
  /** Market prices are loading: a pulse holds the place of today's move and its line. */
  pending?: boolean;
  /** The rail's last line, where the boards had the APY (D19): "● 11.2 shares". */
  shares?: number;
}) {
  const tone = today != null ? toneOf(today) : undefined;
  return (
    <Tap
      href={href}
      onClick={onClick}
      className="flex w-[111px] shrink-0 flex-col rounded-[22px] bg-card p-3 text-left leading-[normal] text-ink shadow-[0_1px_3px_rgba(14,13,11,0.06),0_12px_22px_-16px_rgba(14,13,11,0.28)]"
    >
      <span className="flex items-center justify-between">
        <StockAvatar symbol={symbol} />
        <BacksChip backs={backs} compact />
      </span>
      <span className="mt-2 text-[12.5px] font-semibold">{name}</span>
      <span className="mt-px flex">
        <MoneyCompact value={valueUsd} />
      </span>
      {/* Inline in a block, as on the board: the line keeps the card's 16px line box. */}
      {today != null && (
        <span className="mt-px block">
          <span className={`whitespace-nowrap font-mono text-[10px] ${tone === "neg" ? "text-neg" : "text-pos"}`}>
            {formatSignedPct(today)} today
          </span>
        </span>
      )}
      {spark && spark.length > 1 && (
        <Sparkline
          points={downsample(spark, LINE_POINTS.card)}
          tone={tone}
          width={85}
          height={22}
          className="mt-[7px]"
        />
      )}
      {pending && today == null && (
        <span aria-hidden className="mt-[3px] block h-[42px] w-[85px] animate-pulse rounded-lg bg-chip" />
      )}
      {shares != null && (
        <span className="mt-2 flex items-center gap-[5px] whitespace-nowrap text-[11px]">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-brand shadow-[0_0_0_1px_rgba(14,13,11,0.18)]"
          />
          <b className="num font-semibold">{formatShares(shares)}</b>
          <span className="text-subtle">shares</span>
        </span>
      )}
    </Tap>
  );
}

/** The Home rail's dashed last card while it holds fewer than three stocks (F2-1): it opens the Market. */
export function AddStockCard({ href }: { href: string }) {
  return (
    <Tap
      href={href}
      className="flex w-[111px] shrink-0 flex-col items-center justify-center gap-2 rounded-[22px] border-[1.5px] border-dashed border-[rgba(14,13,11,0.2)] text-xs font-semibold leading-[normal] text-ink-mid"
    >
      <span aria-hidden className="flex size-[30px] items-center justify-center rounded-[15px] bg-pill">
        <PlusIcon size={14} strokeWidth={2.2} />
      </span>
      Add a stock
    </Tap>
  );
}

/** A holding in the Invest list (PortfolioPage): name and shares, its line, value and today's move, then what it backs. */
export function HoldingRow({
  symbol,
  name,
  valueUsd,
  backs,
  today,
  spark,
  shares,
  priceUsd,
  note,
  href,
  onClick,
}: HoldingProps & {
  shares: number;
  /** The price a share the value uses (Aave's), on the chip line's left (Adrian, 2026-10-15). */
  priceUsd?: number;
  /** A plain-words problem with this stock, in red under the row ("Aave has paused this stock for now."). */
  note?: ReactNode;
}) {
  const tone = today != null ? toneOf(today) : undefined;
  return (
    <Tap
      href={href}
      onClick={onClick}
      className="block w-full border-b border-card-bone px-0.5 py-3.5 text-left leading-[normal] text-ink last:border-b-0"
    >
      <span className="flex items-center gap-2.5">
        <StockAvatar symbol={symbol} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block whitespace-nowrap text-[15px] font-semibold leading-[1.25]">{name}</span>
          <span className="mt-0.5 block whitespace-nowrap text-[13px] font-medium leading-[1.35] text-ink-mid">
            {formatShares(shares)} shares
          </span>
        </span>
        {spark && spark.length > 1 && (
          <Sparkline
            points={downsample(spark, LINE_POINTS.row)}
            tone={tone}
            variant="row"
            width={46}
            height={24}
            className="shrink-0"
          />
        )}
        <span className="min-w-[84px] text-right">
          <span className="num block whitespace-nowrap text-[15px] font-semibold leading-[1.25]">
            {formatUsd(valueUsd)}
          </span>
          {today != null && (
            <span
              className={`mt-0.5 block whitespace-nowrap font-mono text-[12px] leading-[1.35] ${tone === "neg" ? "text-neg" : "text-pos"}`}
            >
              {formatSignedPct(today)} today
            </span>
          )}
        </span>
      </span>
      <span className="mt-2.5 flex items-center gap-1.5">
        {priceUsd != null && priceUsd > 0 && (
          <span className="num whitespace-nowrap text-[12.5px] text-ink-mid">
            <b className="font-semibold text-ink-2">{formatUsd(priceUsd)}</b> a share
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <BacksChip backs={backs} />
          {(href || onClick) && <ChevronRight strokeWidth={2.2} className="shrink-0 text-ink-faint" />}
        </span>
      </span>
      {note && <span className="mt-2 block text-[12px] text-act">{note}</span>}
    </Tap>
  );
}

/** "Your holdings" and the white card its rows sit in (PortfolioPage). */
export function HoldingList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 leading-[normal]">
      <h2 className="label m-0 px-1">{title}</h2>
      <div className="rounded-[22px] bg-card px-[18px] py-0.5 shadow-card-elev">{children}</div>
    </section>
  );
}

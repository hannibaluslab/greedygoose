"use client";

import { useState, type ReactNode } from "react";
import { FeedCard, FeedDays } from "./activity/Activity";
import { TodayChange, TodayPending } from "./BalanceHero";
import { MoneyCompact } from "./Money";
import { PriceChart } from "./PriceChart";
import { SegmentedControl } from "./SegmentedControl";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { BacksIcon } from "./icons";
import { useActivity } from "@/hooks/useActivity";
import { aboutStock } from "@/lib/activity/decode";
import type { MarketPrices } from "@/hooks/useMarketPrices";
import { useNowSec } from "@/hooks/useNowSec";
import type { Holding } from "@/hooks/usePosition";
import { usePriceHistory } from "@/hooks/usePriceHistory";
import { formatShares, formatUsd } from "@/lib/formatting";
import { holdingSplit } from "@/lib/holding";
import { RANGES, moveUsd, yearLineStart, type Range } from "@/lib/prices/market";
import { RetryButton } from "./RetryButton";

/** Pieces of the stock sheet's first step (StockSheet), from NYM's CoinDetailSheet in the GreedyGoose kit. */

const RANGE_WORDS: Record<Range, string> = { "1D": "1 day", "1W": "7 days", "1M": "1 month", "1Y": "1 year" };
const RANGE_OPTIONS = (Object.keys(RANGES) as Range[]).map((r) => ({ value: r, label: r }));
/** Daily closes are UTC days. */
const UTC_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The stock: its badge, ticker, market price and today's move (NYM's identity row). Market prices are labelled as
 * such; when none can be had, Aave's price takes the place, labelled too.
 */
export function StockHeader({ holding, market }: { holding: Holding; market: MarketPrices }) {
  const m = market.bySymbol[holding.symbol];
  const ticker = tickerOf(holding.symbol);
  return (
    <div className="flex items-center gap-3 leading-[normal]">
      <StockAvatar symbol={holding.symbol} size={48} />
      <div className="num flex min-w-0 flex-1 flex-col gap-1">
        <span className="label">
          {ticker} · {m || market.loading ? "Market price" : "Aave’s price"}
        </span>
        {m ? (
          <span className="text-[30px] font-semibold leading-none tracking-[-0.03em]">{formatUsd(m.price)}</span>
        ) : market.loading ? (
          <span aria-hidden className="h-[30px] w-[132px] animate-pulse rounded-lg bg-chip" />
        ) : (
          <span className="text-[30px] font-semibold leading-none tracking-[-0.03em]">
            {formatUsd(holding.priceUsd)}
          </span>
        )}
        <span className="flex items-center gap-2 text-[13px] text-ink-mid">
          {m ? (
            <span>
              <TodayChange usd={moveUsd(m.price, m.change)} pct={m.change} />
            </span>
          ) : market.loading ? (
            <TodayPending />
          ) : (
            <>
              No market price right now.
              <RetryButton look="inline" onClick={market.retry} />
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Your holding of the stock (the boards' "Your holdings"; never "your shares", CLAUDE.md › Compliance): how many, what
 * they're worth at Aave's price, and how they split between backing credit and free.
 */
export function StockPosition({ holding }: { holding: Holding }) {
  const ticker = tickerOf(holding.symbol);
  const { backsPct, freePct } = holdingSplit(holding);
  return (
    <section className="num flex flex-col gap-3 rounded-[22px] bg-card p-4 leading-[normal] shadow-card-elev">
      <div className="flex items-center justify-between">
        <span className="label">My holding</span>
        <span className="text-xs text-subtle">At Aave’s price</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[26px] font-semibold leading-none tracking-[-0.03em]">
          {formatShares(holding.freeShares + holding.backingShares)}{" "}
          <span className="text-[15px] font-medium tracking-normal text-subtle">{ticker}</span>
        </span>
        <MoneyCompact value={holding.freeUsd + holding.backingUsd} size={20} />
      </div>
      <div
        role="img"
        aria-label={`${backsPct}% backs credit, ${freePct}% free`}
        className="h-1.5 overflow-hidden rounded-[3px] bg-[rgba(14,13,11,0.08)]"
      >
        <div className="h-1.5 rounded-[3px] bg-ink" style={{ width: `${backsPct}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[12.5px] text-ink-mid">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <BacksIcon size={9} className="text-ink" />
          <b className="font-semibold text-ink">{backsPct}%</b> backs credit · {formatShares(holding.backingShares)}
        </span>
        <span className="whitespace-nowrap">
          <b className="font-semibold text-ink">{freePct}%</b> free · {formatShares(holding.freeShares)}
        </span>
      </div>
    </section>
  );
}

/** NYM's range chart card: the line over the chosen range, the range control and what the line is. */
export function StockChart({ holding, name }: { holding: Holding; name: string }) {
  const [range, setRange] = useState<Range>("1D");
  const history = usePriceHistory(holding, range);
  const points = history.points;
  const nowMs = useNowSec() * 1000;
  // A year holds what there is: since the token launched, when that's inside the year.
  const since = points && !history.stale ? yearLineStart(range, points.length, nowMs) : null;
  const span = since ? `since ${UTC_DAY.format(since)}` : RANGE_WORDS[range];
  return (
    <section className="flex flex-col gap-3 rounded-[22px] bg-card p-4 leading-[normal] shadow-card-elev">
      {points ? (
        <div className="relative">
          <PriceChart
            points={points}
            height={150}
            label={`${name}’s market price ${since ? span : `over ${span}`}, from ${formatUsd(points[0])} to ${formatUsd(points[points.length - 1])}`}
            className={`transition-opacity ${history.stale ? "opacity-40" : "opacity-100"}`}
          />
          {history.stale && (
            <span className="absolute inset-0 grid place-items-center font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">
              Loading {range}…
            </span>
          )}
        </div>
      ) : history.loading ? (
        <div aria-busy className="h-[150px] animate-pulse rounded-[14px] bg-chip" />
      ) : (
        <p role="status" className="m-0 flex h-[150px] items-center justify-between gap-3 text-[13px] text-ink-mid">
          Market prices aren’t available right now.
          <RetryButton look="inline" onClick={history.retry} />
        </p>
      )}
      <SegmentedControl options={RANGE_OPTIONS} value={range} onChange={setRange} label="Chart range" />
      <span className="font-mono text-[10px] uppercase leading-3 tracking-[0.08em] text-subtle">
        Market prices · {span}
      </span>
    </section>
  );
}

/** NYM's stat card, in the boards' field border. */
export function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-[16px] border border-line-field bg-card px-3.5 py-3 leading-[normal]">
      <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-subtle">{label}</div>
      <div className="num mt-1.5 truncate text-[16px] font-semibold tracking-[-0.01em]">{value}</div>
    </div>
  );
}

/**
 * This stock's moves only: JAW's call history for the account, each transaction decoded from its Base receipt (Leo's
 * Activity), kept when the stock is the move's main item (aboutStock), not when it only backs another buy. With
 * nothing to show for a stock you don't own, it isn't drawn.
 */
export function StockActivity({
  user,
  holding,
  name,
  owned,
}: {
  user: `0x${string}`;
  holding: Holding;
  name: string;
  owned: boolean;
}) {
  const { rows, isLoading, isError, refetch } = useActivity(user);
  const nowMs = useNowSec() * 1000;
  const mine = rows.filter((r) => aboutStock(r.items, holding.symbol));
  if (!owned && !isLoading && !isError && mine.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="label m-0 px-1">Activity</h3>
      <FeedCard>
        {isLoading ? (
          <div aria-busy className="flex flex-col gap-3 py-3.5">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-[16px] bg-chip" />
            ))}
          </div>
        ) : isError ? (
          <div className="py-3.5">
            <p role="alert" className="m-0 text-sm text-ink-2">
              We couldn’t load your activity.
            </p>
            <div className="mt-2.5">
              <RetryButton onClick={() => void refetch()} />
            </div>
          </div>
        ) : mine.length === 0 ? (
          <p className="m-0 py-3.5 text-sm leading-[1.4] text-ink-mid">
            Nothing yet. What you do with {name} in GreedyGoose shows up here.
          </p>
        ) : (
          <FeedDays rows={mine} nowMs={nowMs} />
        )}
      </FeedCard>
    </section>
  );
}

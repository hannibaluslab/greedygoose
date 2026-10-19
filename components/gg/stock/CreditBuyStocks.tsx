"use client";

import type { ReactNode } from "react";
import { StockAvatar } from "../kit/StockAvatar";
import { ChevronRight } from "../kit/icons";
import { RetryButton } from "../kit/RetryButton";
import { wholeUsd } from "./CreditBuyBacking";
import type { Holding } from "@/hooks/usePosition";
import type { CreditAvailable } from "@/lib/creditBuy";
import { formatUsd } from "@/lib/formatting";
import { EQUITIES, type ReserveAsset } from "@/lib/tokens/registry";

const valueOf = (h: Holding) => h.freeUsd + h.backingUsd;

/**
 * Step 3's lists (F2-3): the holdings, then the other stocks. `othersFirst` (the stock to buy): the other stocks on
 * top, since a Credit Buy usually buys something new, and the holdings under them. `withCash`: the $0 state, where a
 * tap buys with cash.
 */
export function StockLists({
  held,
  others,
  priceOf,
  withCash,
  othersFirst = false,
  onPick,
}: {
  held: Holding[];
  others: ReserveAsset[];
  priceOf: (symbol: string) => number;
  withCash: boolean;
  othersFirst?: boolean;
  onPick: (s: ReserveAsset) => void;
}) {
  const heldList = held.length > 0 && (
    <PickList title="My holdings">
      {held.map((h) => (
        <PickRow
          key={h.symbol}
          symbol={h.symbol}
          name={h.name}
          owned={valueOf(h)}
          priceUsd={h.priceUsd}
          withCash={withCash}
          disabled={false}
          onClick={() => {
            const stock = EQUITIES.find((e) => e.symbol === h.symbol);
            if (stock) onPick(stock);
          }}
        />
      ))}
    </PickList>
  );
  const othersList = others.length > 0 && (
    <PickList title={withCash ? "Buy with cash" : held.length > 0 ? "Other stocks" : "Stocks"}>
      {others.map((e) => (
        <PickRow
          key={e.symbol}
          symbol={e.symbol}
          name={e.name}
          priceUsd={priceOf(e.symbol)}
          withCash={withCash}
          disabled={false}
          onClick={() => onPick(e)}
        />
      ))}
    </PickList>
  );
  return othersFirst ? (
    <>
      {othersList}
      {heldList}
    </>
  ) : (
    <>
      {heldList}
      {othersList}
    </>
  );
}

/**
 * F2-3's head (Adrian, 2026-10-15): the most one Credit Buy can use, in whole dollars as the sheet's credit figures,
 * drawn like the balance hero's figure, read out as one amount; a pulse while the backing factors load, and a plain
 * line with Try again if they can't be read. One plain line under it. At $0 the label drops "up to".
 */
export function CreditHero({
  available,
  failed,
  onRetry,
}: {
  available: CreditAvailable | null;
  failed: boolean;
  onRetry: () => void;
}) {
  // Rounded down; to the cent under $100, so a small account's $0.72 isn't "$0".
  const figure = available ? wholeUsd(available.usd) : "$0";
  const none = !available || available.usd < 0.01;
  return (
    <div className="flex flex-col gap-1.5 px-1 leading-[normal]">
      <span className="label">{available && none ? "Credit you can use" : "You can use up to"}</span>
      {available ? (
        <span className="num inline-flex items-baseline">
          <span aria-hidden className="text-[22px] font-medium text-ink-mid">
            $
          </span>
          <span aria-hidden className="text-[44px] font-semibold leading-none tracking-[-0.04em]">
            {figure.replace("$", "")}
          </span>
          <span className="sr-only">{figure}</span>
        </span>
      ) : failed ? null : (
        <span role="status" className="h-[42px] w-[150px] animate-pulse rounded-xl bg-chip">
          <span className="sr-only">Loading</span>
        </span>
      )}
      {available ? (
        <p className="m-0 text-pretty text-[13px] leading-[1.4] text-ink-mid">{available.line}</p>
      ) : (
        failed && <CantCheck onRetry={onRetry} />
      )}
    </div>
  );
}

/**
 * The $0 state's stocks, which buy with cash (a tap opens the stock's Buy step): only the stock picked already, when
 * the sheet opened on one.
 */
export function CashStockLists({
  held,
  others,
  preset,
  priceOf,
  onPick,
}: {
  held: Holding[];
  others: ReserveAsset[];
  preset: ReserveAsset | null;
  priceOf: (symbol: string) => number;
  onPick: (symbol: string) => void;
}) {
  const only = <T extends { symbol: string }>(list: T[]) =>
    preset ? list.filter((s) => s.symbol === preset.symbol) : list;
  return (
    <StockLists held={only(held)} others={only(others)} priceOf={priceOf} withCash onPick={(s) => onPick(s.symbol)} />
  );
}

/** The backing factors are loading (a pulse), or couldn't be read (CantCheck). */
export function CreditPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return failed ? (
    <CantCheck onRetry={onRetry} />
  ) : (
    <div aria-busy className="h-[220px] animate-pulse rounded-[16px] bg-chip" />
  );
}

/** The backing factors couldn't be read: say so, with Try again (ValueLine's pattern), instead of pulsing on. */
function CantCheck({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="status" className="m-0 flex items-center justify-between gap-3 text-[13px] leading-[normal] text-ink-mid">
      Your credit can’t be checked right now.
      <RetryButton look="inline" onClick={onRetry} />
    </p>
  );
}

/** F2-3's titled white list. */
function PickList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 leading-[normal]">
      <h3 className="label m-0 px-1">{title}</h3>
      <div className="rounded-[16px] border border-line-field bg-card">{children}</div>
    </section>
  );
}

/**
 * A stock to Credit Buy (F2-3): badge, name ("You own $X" for a holding), its price. Stocks earn no yield (D19), so
 * "per share" sits where the board had the APY. `withCash`: with $0 to use it opens a Buy with cash, and its name says so.
 * `disabled` until the number is known.
 */
function PickRow({
  symbol,
  name,
  owned,
  priceUsd,
  withCash,
  disabled,
  onClick,
}: {
  symbol: string;
  name: string;
  owned?: number;
  priceUsd: number;
  withCash: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex min-h-16 w-full items-stretch pl-4 text-left text-ink"
    >
      <span className="flex items-center py-2.5">
        <StockAvatar symbol={symbol} size={40} font={9.5} weight={800} />
      </span>
      <span className="ml-3 flex min-w-0 flex-1 items-center gap-3 border-b border-line-field py-2.5 pr-4 group-last:border-b-0">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[15px] font-semibold leading-[18px]">{name}</span>
          {owned !== undefined && (
            <span className="num whitespace-nowrap text-[13px] font-medium leading-[18px] text-ink-mid">
              You own <b className="font-semibold text-ink">{formatUsd(owned)}</b>
            </span>
          )}
        </span>
        <span className="num flex shrink-0 flex-col items-end gap-1 whitespace-nowrap">
          <span className="text-[15px] font-semibold leading-[18px]">{formatUsd(priceUsd)}</span>
          <span className="text-[12px] font-medium leading-4 text-ink-mid">per share</span>
        </span>
        <ChevronRight strokeWidth={2.2} className="shrink-0 text-ink-faint" />
        {withCash && <span className="sr-only">, buy with cash</span>}
      </span>
    </button>
  );
}

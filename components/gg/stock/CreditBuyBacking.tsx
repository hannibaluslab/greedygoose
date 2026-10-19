"use client";

import { createContext, useContext, type ReactNode } from "react";
import { StockAvatar, tickerOf } from "../kit/StockAvatar";
import { BacksIcon } from "../kit/icons";
import type { Holding } from "@/hooks/usePosition";
import { MIN_BACKING_USD, shortNames, type BackingOption } from "@/lib/creditBuy";
import { floorCents, formatShares, formatUsd, formatUsdTrim } from "@/lib/formatting";
import { wholePct } from "@/lib/holding";

/**
 * Credit figures, rounded down so they're never more than there is: to the cent under $100 (a small account's "Up to
 * $0.68" isn't "$0"), in whole dollars above, as the boards print them ("Up to $417").
 */
export const wholeUsd = (n: number) => {
  const usd = Math.max(0, n);
  return usd < 100 ? formatUsd(floorCents(usd)) : formatUsdTrim(Math.floor(usd));
};

export const optionOf = (options: BackingOption[], h: Holding) => options.find((o) => o.stock.symbol === h.symbol);

/**
 * Step 1's Credit ready (board 30): the credit left on what already backs credit, from which stocks, picked first.
 * Using it puts nothing new in, so the amount step shows how far it moves the credit.
 */
export function ReadyRow({
  names,
  usd,
  checked,
  onPick,
}: {
  names: string[];
  usd: number;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      className={`flex min-h-11 items-center gap-3 rounded-[16px] bg-card px-3.5 py-3 text-left leading-[normal] text-ink ${checked ? "border-[1.5px] border-ink" : "border border-line-field"}`}
    >
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink">
        <BacksIcon size={12} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">Credit ready</span>
        <span className="truncate text-[12.5px] text-ink-mid">From {shortNames(names)}</span>
      </span>
      <span className="flex shrink-0 flex-col gap-px text-right">
        <span className="text-[11.5px] text-ink-mid">Up to</span>
        <span className="num text-[20px] font-bold leading-[1.1] tracking-[-0.02em]">{wholeUsd(usd)}</span>
      </span>
      <Radio checked={checked} />
    </button>
  );
}

/** How a Repay link inside the sheet leaves it for the Repay sheet (CreditBuySheet sets it). */
export const LeaveForRepay = createContext<() => void>(() => {});

/** "Repay" inside a row or a note: opens the Repay sheet in this one's place. */
function RepayLink() {
  const repay = useContext(LeaveForRepay);
  return (
    <button type="button" onClick={repay} className="font-semibold text-ink">
      Repay
    </button>
  );
}

/** The rows' radio mark: lime with an ink dot when picked. */
function Radio({ checked }: { checked: boolean }) {
  return checked ? (
    <span
      aria-hidden
      className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand shadow-[0_0_0_1.5px_#0e0d0b]"
    >
      <span className="size-2 rounded-full bg-ink" />
    </span>
  ) : (
    <span aria-hidden className="size-[22px] shrink-0 rounded-full border-[1.5px] border-[#d9d2c3]" />
  );
}

/** Why a holding can't back the buy, in a few words; none when it's all in use already (the row says so, with Repay). */
export function unavailable(h: Holding): string | undefined {
  if (h.paused || h.frozen) return "Paused by Aave";
  if (h.freeUsd >= MIN_BACKING_USD) return "Can’t back credit";
  return h.backingRaw > 0n ? undefined : "Too small to back credit";
}

/**
 * A holding that could back the buy (step 1, board F2-4): what it's worth, how much is in use, and either its free
 * value (`right`, a radio) or, without `onPick`, why it can't ("All in use · Repay", disabled).
 */
export function BackingRow({
  holding: h,
  checked = false,
  right,
  onPick,
  reason,
}: {
  holding: Holding;
  checked?: boolean;
  right?: ReactNode;
  onPick?: () => void;
  reason?: string;
}) {
  const ticker = tickerOf(h.symbol);
  const allInUse = !reason && h.backingRaw > 0n && !onPick;
  const body = (
    <>
      <StockAvatar symbol={h.symbol} size={36} font={ticker.length > 4 ? undefined : 10.5} weight={800} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[15px] font-semibold">
          {h.name}
          {onPick && h.backingShares > 0 && (
            <span
              title={`${wholePct(h.backingShares / (h.freeShares + h.backingShares))}% backs credit`}
              className="num inline-flex h-[18px] items-center gap-[3px] rounded-[9px] bg-ground px-1.5 text-[10.5px] font-semibold text-ink-2"
            >
              {wholePct(h.backingShares / (h.freeShares + h.backingShares))}%
              <BacksIcon size={10} />
            </span>
          )}
        </span>
        <span className="num whitespace-nowrap text-[12.5px] text-ink-mid">
          {formatShares(h.freeShares + h.backingShares)} shares
        </span>
        {!onPick && (h.backingShares > 0 || reason) && (
          <span className="num whitespace-nowrap text-[12px] text-ink-mid">
            {reason ?? (
              <>
                <BacksIcon size={10} className="mr-1 inline align-[-1px] text-ink" />
                {allInUse ? (
                  <>
                    <b className="font-semibold text-ink">All</b> in use · <RepayLink />
                  </>
                ) : (
                  <>
                    <b className="font-semibold text-ink">{formatShares(h.backingShares)}</b> in use
                  </>
                )}
              </>
            )}
          </span>
        )}
      </span>
      {onPick ? (
        <span className="flex shrink-0 flex-col gap-px text-right">{right}</span>
      ) : (
        <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-ink-mid">Not available</span>
      )}
      <Radio checked={checked} />
    </>
  );
  const cls = "flex min-h-11 items-center gap-3 rounded-[16px] bg-card px-3.5 py-3 text-left leading-[normal] text-ink";
  return onPick ? (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      className={`${cls} ${checked ? "border-[1.5px] border-ink" : "border border-line-field"}`}
    >
      {body}
    </button>
  ) : (
    <div
      role="radio"
      aria-checked={false}
      aria-disabled
      aria-label={`${h.name}, not available${allInUse ? ": all in use" : reason ? `: ${reason}` : ""}`}
      className={`${cls} border border-line-field opacity-60`}
    >
      {body}
    </div>
  );
}

/**
 * Step 1's quiet note for what can't back this buy (Adrian: disabled rows repeated each other): what already backs
 * credit with nothing left, and holdings too small or paused, each in a few words. Nothing to pick here.
 */
export function CantBack({
  inUse,
  items,
}: {
  inUse: { names: string[]; usd: number } | null;
  items: { name: string; reason: string }[];
}) {
  if (!inUse && items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[16px] border border-dashed border-line-field px-3.5 py-3 text-[12.5px] leading-[1.45] text-ink-mid">
      {inUse && (
        <p className="m-0">
          <BacksIcon size={10} className="mr-1 inline align-[-1px] text-ink" />
          <b className="font-semibold text-ink">{shortNames(inUse.names)}</b> ({formatUsd(inUse.usd)}) already{" "}
          {inUse.names.length > 1 ? "back" : "backs"} your credit, with nothing left to use. <RepayLink />
        </p>
      )}
      {items.map((i) => (
        <p key={i.name} className="m-0">
          <b className="font-semibold text-ink">{i.name}</b>: {i.reason}.
        </p>
      ))}
    </div>
  );
}

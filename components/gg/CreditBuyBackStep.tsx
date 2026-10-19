"use client";

import { useMemo } from "react";
import { Button } from "./Button";
import { BackingRow, CantBack, ReadyRow, optionOf, unavailable, wholeUsd } from "./CreditBuyBacking";
import { CashStockLists, CreditPending } from "./CreditBuyStocks";
import type { Holding, PositionData } from "@/hooks/usePosition";
import {
  backers,
  backingOptions,
  MIN_BACKING_USD,
  NO_CREDIT,
  canBuyWithCash,
  creditAvailable,
  creditWith,
  ownCreditUsd,
  type BackingOption,
  type CreditAvailable,
} from "@/lib/creditBuy";
import { formatUsd } from "@/lib/formatting";
import { BUY_LIMITS } from "@/lib/swap/buy";
import { EQUITIES, byStockOrder, type ReserveAsset } from "@/lib/tokens/registry";

/** Step 1's Credit ready: the credit left on what already backs credit; nothing new goes in. */
const EXISTING = "existing";

/**
 * What the sheet's steps share about the backing: the lists, what can back it, what Credit Buy can use, and the pick
 * (Sam's, or the default) with the most it can back.
 */
export function useBackingPick({
  data,
  cfs,
  onFirstStep,
  picked,
}: {
  data: PositionData;
  cfs: Record<string, number> | undefined;
  onFirstStep: boolean;
  picked: string | null;
}) {
  // Every list in Home's order (ruling 43): the stocks you hold, then the others.
  const held = data.holdings.filter((h) => h.freeShares + h.backingShares > 0).sort(byStockOrder);
  const others = EQUITIES.filter((e) => !held.some((h) => h.symbol === e.symbol));
  const priceOf = (symbol: string) => data.holdings.find((h) => h.symbol === symbol)?.priceUsd ?? 0;

  const options = useMemo(
    () =>
      cfs
        ? backingOptions(data.holdings, cfs)
            .filter((o) => o.freeUsd >= MIN_BACKING_USD && ownCreditUsd(data, o) >= BUY_LIMITS.minUsd)
            .sort((a, b) => byStockOrder(a.stock, b.stock))
        : [],
    [data, cfs],
  );
  // Whether a Credit Buy can use anything at all (with every free holding at its best): $0 says why on step 1.
  // Owning no stock needs no collateral factors to say $0.
  const available =
    cfs || held.length === 0
      ? creditAvailable({ position: data, options, cash: data.cash, holdsStock: held.length > 0 })
      : null;
  // The credit left on what already backs credit alone: step 1's Credit ready.
  const existingLeft = creditWith(data);
  const canUseExisting = data.totalBackingUsd > 0 && existingLeft >= BUY_LIMITS.minUsd;
  // Step 1 picks Credit ready until Sam picks another, else the stock that backs the most on its own. A pick that can't
  // back it any more (too small, paused, or no longer read) falls back to that default on step 1.
  const canPick = (key: string) => (key === EXISTING ? canUseExisting : options.some((o) => o.stock.symbol === key));
  const mostOwn = options.reduce<BackingOption | null>(
    (b, o) => (!b || ownCreditUsd(data, o) > ownCreditUsd(data, b) ? o : b),
    null,
  );
  const fallbackKey = canUseExisting ? EXISTING : (mostOwn?.stock.symbol ?? null);
  const pickedKey = (onFirstStep && picked && !canPick(picked) ? null : picked) ?? fallbackKey;
  const chosen = options.find((o) => o.stock.symbol === pickedKey) ?? null;
  // Past step 1, a picked holding that dropped out of the list: the buy can't quietly fall back to what already backs
  // credit, so nothing is prepared for it, and the next steps say so and send Sam back to pick again (the sheet's
  // `lostPick`: not once the batch is on its way or has landed).
  const pickGone = !onFirstStep && !!picked && picked !== EXISTING && !chosen;
  // The most this pick can back: Credit ready's credit left, or what the stock backs on its own. Step 3's number and the
  // amount's "Up to" are this one figure.
  const reachUsd = chosen ? ownCreditUsd(data, chosen) : existingLeft;
  return {
    held,
    others,
    priceOf,
    options,
    available,
    existingLeft,
    canUseExisting,
    pickedKey,
    chosen,
    pickGone,
    reachUsd,
  };
}

/**
 * Step 1, "Back it with" (board 30): Credit ready first (what already backs credit, nothing new goes in), then each
 * stock that can back new credit, with what it backs on its own, then what can't, and why. With $0 to use it says why,
 * and the stocks buy with cash.
 */
export function CreditBuyBackStep({
  data,
  cfs,
  cfFailed,
  onRetry,
  available,
  options,
  held,
  others,
  preset,
  priceOf,
  existingLeft,
  canUseExisting,
  pickedKey,
  onChoose,
  onContinue,
  onTopUp,
  onBuyWithCash,
}: {
  data: PositionData;
  cfs: Record<string, number> | undefined;
  cfFailed: boolean;
  onRetry: () => void;
  available: CreditAvailable | null;
  options: BackingOption[];
  held: Holding[];
  others: ReserveAsset[];
  preset: ReserveAsset | null;
  priceOf: (symbol: string) => number;
  existingLeft: number;
  canUseExisting: boolean;
  pickedKey: string | null;
  onChoose: (key: string) => void;
  onContinue: () => void;
  onTopUp: () => void;
  onBuyWithCash: (symbol: string) => void;
}) {
  // What each free holding backs on its own (ownCreditUsd), so one too small for the smallest buy is listed with that
  // reason instead of being offered (Adrian: $1 of Alphabet read as "nothing free").
  const gives = useMemo(
    () => new Map(cfs ? backingOptions(data.holdings, cfs).map((o) => [o.stock.symbol, ownCreditUsd(data, o)]) : []),
    [data, cfs],
  );
  if (!available) return <CreditPending failed={cfFailed} onRetry={onRetry} />;
  const cashLists = (
    <CashStockLists held={held} others={others} preset={preset} priceOf={priceOf} onPick={onBuyWithCash} />
  );
  if (available.why === "no-stocks")
    return (
      // No stocks at all (Adrian: step 1 always shows; rulings 8, 9): where credit comes from, what to do first
      // and, with no cash to buy one, Top up; then the stocks, which buy with cash. Holding any stock shows it
      // below instead, with why it can't back this yet.
      <div className="flex flex-col gap-3 pt-1">
        <h3 className="label m-0 px-1">Back it with</h3>
        <div className="flex flex-col items-center gap-1.5 rounded-[16px] border-[1.5px] border-dashed border-[rgba(14,13,11,0.2)] px-5 py-5 text-center">
          <p className="m-0 text-[15px] font-semibold">{NO_CREDIT["no-stocks"]}</p>
          <p className="m-0 text-pretty text-[13px] leading-[1.4] text-ink-mid">{available.line}</p>
          {!canBuyWithCash(data.cash) && (
            <Button variant="dark" onClick={onTopUp} className="mt-2 w-full">
              Top up
            </Button>
          )}
        </div>
        {cashLists}
      </div>
    );

  // In Act no credit is taken (Act is the line): one line says so, with no list of why each holding can't.
  const inAct = available.why === "in-act";
  const names = backers(data.holdings, []).map((h) => h.name);
  // What can't back it, and why; all in use is named by CantBack's own line.
  const cantBack = inAct
    ? []
    : held
        .filter((h) => !optionOf(options, h))
        .flatMap((h) => {
          const g = gives.get(h.symbol);
          const reason =
            g != null && g < BUY_LIMITS.minUsd && !h.paused && !h.frozen && h.freeUsd >= MIN_BACKING_USD
              ? `gives ${formatUsd(Math.max(0, g))} of credit, under the smallest buy`
              : unavailable(h)?.toLowerCase();
          return reason ? [{ name: h.name, reason }] : [];
        });
  return (
    <>
      <div role="radiogroup" aria-label="Back it with" className="flex flex-col gap-2">
        {canUseExisting && (
          <ReadyRow
            names={names}
            usd={existingLeft}
            checked={pickedKey === EXISTING}
            onPick={() => onChoose(EXISTING)}
          />
        )}
        {options.length > 0 && <h3 className="label m-0 px-1 pt-2">Back new credit with</h3>}
        {options.map((o) => {
          const h = data.holdings.find((x) => x.symbol === o.stock.symbol);
          return (
            h && (
              <BackingRow
                key={h.symbol}
                holding={h}
                checked={pickedKey === h.symbol}
                right={
                  <>
                    <span className="text-[11.5px] text-ink-mid">Up to</span>
                    <span className="num text-[20px] font-bold leading-[1.1] tracking-[-0.02em]">
                      {wholeUsd(ownCreditUsd(data, o))}
                    </span>
                  </>
                }
                onPick={() => onChoose(h.symbol)}
              />
            )
          );
        })}
      </div>
      <CantBack
        inUse={data.totalBackingUsd > 0 && !canUseExisting && !inAct ? { names, usd: data.totalBackingUsd } : null}
        items={cantBack}
      />
      {available.why ? (
        // Holdings, but none can back a Credit Buy yet: why, and the stocks still buy with cash.
        <>
          <p role="status" className="m-0 px-1 text-[13px] leading-[1.4] text-ink-mid">
            {available.line}
          </p>
          {cashLists}
        </>
      ) : (
        <>
          {options.length > 0 && (
            <p className="m-0 px-1 text-[12.5px] leading-[1.4] text-ink-mid">Only what your buy needs goes in.</p>
          )}
          <Button variant="dark" disabled={!pickedKey} onClick={onContinue} className="mt-1">
            Continue
          </Button>
        </>
      )}
    </>
  );
}

/** Past step 1, the holding picked there can't back credit any more: say so, and pick again (a pulse while it's read). */
export function LostPick({
  symbol,
  read,
  cfFailed,
  onRetry,
  onPickAgain,
}: {
  symbol: string | null;
  read: boolean;
  cfFailed: boolean;
  onRetry: () => void;
  onPickAgain: () => void;
}) {
  if (!read) return <CreditPending failed={cfFailed} onRetry={onRetry} />;
  return (
    <>
      <p role="status" className="m-0 px-1 pt-1 text-[15px] leading-snug text-ink">
        {EQUITIES.find((e) => e.symbol === symbol)?.name ?? "That stock"} can’t back credit right now.
      </p>
      <Button variant="dark" onClick={onPickAgain} className="mt-1">
        Pick again
      </Button>
    </>
  );
}

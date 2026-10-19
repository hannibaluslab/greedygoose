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
  ownCreditUsd,
  type BackingOption,
  type CreditAvailable,
} from "@/lib/creditBuy";
import { formatUsd } from "@/lib/formatting";
import { BUY_LIMITS } from "@/lib/swap/buy";
import type { ReserveAsset } from "@/lib/tokens/registry";

/** Step 1's Credit ready: the credit left on what already backs credit; nothing new goes in. */
export const EXISTING = "existing";

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
  cfs: Record<string, number> | null | undefined;
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

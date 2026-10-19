"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { AmountArrow, AmountField, AmountHintLine, AmountSource, YouGetCash } from "../kit/AmountField";
import { StockAvatar, tickerOf } from "../kit/StockAvatar";
import { Summary } from "../home/Summary";
import { StockStep } from "./StockStep";
import { TxButton, TxDone, TxError } from "../TxUi";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useMarketPrices } from "@/hooks/useMarketPrices";
import type { Holding, PositionData } from "@/hooks/usePosition";
import { useSell, useSellQuote } from "@/hooks/useSell";
import { toUsd } from "@/lib/cash";
import { formatShares, formatUsd } from "@/lib/formatting";
import { SELL_BLOCKED, floorPriceUsd, planSell, type SellPlan } from "@/lib/sell";
import { tradeAmount } from "@/lib/trade";
import { SELL_LIMITS, sellEconomics, type SellQuote } from "@/lib/swap/sell";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import type { ReserveAsset } from "@/lib/tokens/registry";

type Step = "stock" | "sell";
const ORDER: Step[] = ["stock", "sell"];

/**
 * One stock in a sheet: NYM's CoinDetailSheet in the GreedyGoose kit, opened from the Home rail, the Invest rows and
 * the Market. The stock's market price and today's move, your holding and how it splits, the price chart, its share
 * of your portfolio and Aave's price (stocks earn no yield, D19), the actions, and this stock's moves. Selling is a step
 * inside this sheet (useSell), in dollars up to $X, the free shares: shares that back credit come back with a repay
 * first. Its Sell opens JAW's own sheet: the step says the lowest price, what moves and the fee, so there is no
 * confirm of ours. Buy, Credit Buy and Free up shares open their own flows, which
 * come back here (StockSheets). For a stock you don't own: Buy and Credit Buy only.
 */
export function StockSheet({
  open,
  user,
  data,
  stock,
  holding,
  onClose,
  onBack,
  onBuy,
  onCreditBuy,
  onFreeUp,
}: {
  open: boolean;
  user: `0x${string}`;
  data: PositionData;
  stock: ReserveAsset;
  holding: Holding;
  onClose: () => void;
  /** Opened from the Market: Back returns there. */
  onBack?: () => void;
  onBuy: () => void;
  onCreditBuy: () => void;
  onFreeUp: () => void;
}) {
  const { isConnected } = useAccount();
  const market = useMarketPrices([holding]);
  const fee = useFeeSupport();

  const [step, setStep] = useState<Step>("stock");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  // What went to JAW's sheet: once the sale lands the shares are re-read, and MAX's free shares are then none.
  const [sold, setSold] = useState(0n);
  const go = (next: Step) => {
    setDirection(ORDER.indexOf(next) > ORDER.indexOf(step) ? "forward" : "back");
    setStep(next);
  };

  // Up to $X (canvas board 9): the free shares only. The dollars typed become shares at Aave's price, as on Trade; MAX,
  // or an amount that would leave dust, sells every free share to the last unit.
  const { sharesRaw, maxUsd } = tradeAmount({ from: holding.symbol, to: "cash", amount, all, data });

  const { quote, q, plan, econ, blocker, note, ready, feeBlocked, signable, tx } = useSale({
    live: open && step === "sell",
    quoting: step !== "stock",
    user,
    data,
    stock,
    holding,
    sharesRaw,
    isConnected,
    feeUnsupported: fee.state === "unsupported",
  });
  const { sign, phase, error, reset, busy, txHash, checking, blocked } = tx;

  const back = () => {
    if (busy) onClose();
    else {
      if (phase === "failed") reset();
      go("stock");
    }
  };
  const done = phase === "done";

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={step === "sell" && !done ? `Sell ${stock.name}` : stock.name}
      onBack={step === "stock" ? onBack : done ? undefined : back}
    >
      <SheetSteps stepKey={done ? "done" : step} direction={direction} className="flex flex-col gap-3">
        {done ? (
          <TxDone
            title={`Sold ${formatShares(rawToShares(sold, holding.multiplier, stock.decimals))} ${stock.name}`}
            body="What the sale paid is in your cash."
            txHash={txHash}
            onDone={onClose}
          />
        ) : step === "stock" ? (
          <StockStep
            user={user}
            data={data}
            stock={stock}
            holding={holding}
            market={market}
            onBuy={onBuy}
            onSell={() => go("sell")}
            onCreditBuy={onCreditBuy}
            onFreeUp={onFreeUp}
          />
        ) : (
          <>
            <AmountField
              label="You sell"
              source={<AmountSource mark={<StockAvatar symbol={stock.symbol} size={16} />}>{stock.name}</AmountSource>}
              badge={<StockAvatar symbol={stock.symbol} />}
              value={amount}
              onValue={(v) => {
                setAll(false);
                setAmount(v);
              }}
              onMax={
                maxUsd > 0
                  ? () => {
                      setAll(true);
                      setAmount(String(maxUsd));
                    }
                  : undefined
              }
              hint={
                <AmountHintLine
                  hint={{
                    shares: rawToShares(sharesRaw, holding.multiplier, stock.decimals),
                    priceUsd: holding.priceUsd,
                    upToUsd: maxUsd,
                  }}
                />
              }
              autoFocus
            />
            <AmountArrow />
            <YouGetCash usd={quote.isFetching && sharesRaw > 0n ? null : econ ? econ.usd : 0} />
            <Summary
              rows={[
                {
                  label: "Lowest price",
                  value: plan && !quote.isFetching ? `${formatUsd(floorPriceUsd(plan, stock))} a share` : "…",
                },
              ]}
            />
            {note && (
              <p role="status" className={`m-0 text-[13px] leading-snug ${blocker ? "text-act" : "text-watch-text"}`}>
                {note}
              </p>
            )}
            {ready && plan && q && <SellSmallPrint stock={stock} holding={holding} quote={q} plan={plan} />}
            {feeBlocked && (
              <p role="alert" className="m-0 text-[13px] text-act">
                Your account can’t pay network fees from your cash right now, so this sale can’t go through.
              </p>
            )}
            <TxError error={error} />
            <div className="mt-1">
              <TxButton
                label="Sell"
                size="md"
                phase={phase}
                checking={checking}
                preview={!isConnected}
                disabled={!signable || fee.loading || blocked}
                onClick={() => {
                  if (!signable) return;
                  if (phase === "failed") reset();
                  setSold(signable.plan.sharesRaw);
                  void sign();
                }}
              />
            </div>
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

/**
 * The sale step's quote for the shares, its plan, why it can't go or what to look out for, and the batch Sell would
 * sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
 */
function useSale(p: {
  live: boolean;
  quoting: boolean;
  user: `0x${string}`;
  data: PositionData;
  stock: ReserveAsset;
  holding: Holding;
  sharesRaw: bigint;
  isConnected: boolean;
  feeUnsupported: boolean;
}) {
  const { user, data, stock, holding, sharesRaw } = p;
  const quote = useSellQuote(stock, p.quoting ? sharesRaw : 0n);
  const q = quote.data ?? null;
  const plan = q ? planSell({ from: "free", stock, holding, cf: 0, position: data, quote: q }) : null;
  const econ = q ? sellEconomics(q, stock, holding.priceUsd) : null;

  const { blocker, note } = saleLines({ sharesRaw, maxRaw: holding.freeRaw, quote, plan, name: stock.name });
  const ready = sharesRaw > 0n && !!plan && q?.amountIn === sharesRaw && !blocker && !quote.isFetching;
  const feeBlocked = p.isConnected && p.feeUnsupported;
  const signable =
    p.live && ready && plan && q && !feeBlocked
      ? { user, stock, quote: q, plan, oraclePriceUsd: holding.priceUsd, debtRaw: data.debtRaw }
      : null;
  const tx = useSell(signable);
  return { quote, q, plan, econ, blocker, note, ready, feeBlocked, signable, tx };
}

/** Why the sale can't go (blocker), or what to look out for: a small market, or markets closed (note, either). */
function saleLines(p: {
  sharesRaw: bigint;
  maxRaw: bigint;
  quote: { isSuccess: boolean; data?: SellQuote | null };
  plan: SellPlan | null;
  name: string;
}) {
  const { sharesRaw, plan, name } = p;
  const q = p.quote.data ?? null;
  let blocker: string | null = null;
  if (sharesRaw > p.maxRaw) blocker = SELL_BLOCKED["not-free"];
  else if (sharesRaw > 0n && p.quote.isSuccess && q === null) blocker = `There’s no market for ${name} right now.`;
  else if (plan?.block) blocker = SELL_BLOCKED[plan.block];
  const warning =
    blocker ??
    (plan?.warn
      ? `You’d get ${(plan.discount * 100).toFixed(1)}% under Aave’s price. The market for ${name} is small.`
      : null);
  const note =
    warning ??
    (plan?.priceMayMove
      ? "Stock markets are closed. You can still sell, but the price can jump when they reopen."
      : null);
  return { blocker, note };
}

/**
 * The Sell step's small print (and the Trade sheet's stock → cash): every move in the batch (D7) and the lowest price
 * the swap accepts. What the stock is stays in the sheet's footnote (ruling 35).
 */
export function SellSmallPrint({
  stock,
  holding,
  quote,
  plan,
}: {
  stock: ReserveAsset;
  holding: Holding;
  quote: SellQuote;
  plan: SellPlan;
}) {
  const ticker = tickerOf(stock.symbol);
  const shares = formatShares(rawToShares(plan.sharesRaw, holding.multiplier, stock.decimals));
  const floor = formatUsd(floorPriceUsd(plan, stock));
  const venue = VENUE_LABEL[quote.venue];
  return (
    <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
      In one go: exactly {shares} {ticker} is approved for the {venue} router and swapped, and at least{" "}
      {formatUsd(toUsd(plan.minOutRaw))} lands in your cash. If the price falls under {floor} a share, the sale is
      cancelled, so it never sells for more than {SELL_LIMITS.floorBps / 100}% under Aave’s price (
      {formatUsd(holding.priceUsd)}).
    </p>
  );
}

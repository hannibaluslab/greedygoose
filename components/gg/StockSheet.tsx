"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { AmountArrow, AmountField, AmountSource, YouGetCash } from "./AmountField";
import { Button } from "./Button";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { StatCard, StockActivity, StockChart, StockHeader, StockPosition } from "./StockOverview";
import { NETWORK_FEE_ROW, Summary } from "./Summary";
import { TxButton, TxDone, TxError } from "./TxUi";
import { CreditIcon } from "./icons";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useMarketPrices } from "@/hooks/useMarketPrices";
import type { Holding, PositionData } from "@/hooks/usePosition";
import { useSell, useSellQuote } from "@/hooks/useSell";
import { toUsd } from "@/lib/cash";
import { formatShares, formatUsd } from "@/lib/formatting";
import { portfolioShare } from "@/lib/holding";
import { SELL_BLOCKED, floorPriceUsd, planSell, type SellPlan } from "@/lib/sell";
import { SELL_LIMITS, sellEconomics, type SellQuote } from "@/lib/swap/sell";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares, sharesToRaw } from "@/lib/tokens/b20";
import type { ReserveAsset } from "@/lib/tokens/registry";

type Step = "stock" | "sell";
const ORDER: Step[] = ["stock", "sell"];

/**
 * One stock in a sheet: NYM's CoinDetailSheet in the GreedyGoose kit, opened from the Home rail, the Invest rows and
 * the Market. The stock's market price and today's move, your holding and how it splits, the price chart, its share
 * of your portfolio and Aave's price (stocks earn no yield, D19), the actions, and this stock's moves. Selling free
 * shares is a step inside this sheet (useSell) whose Sell opens JAW's own sheet: the step says the lowest price, what
 * moves and the fee, so there is no confirm of ours. Buy, Credit Buy and Free up shares open their own flows, which
 * come back here (StockSheets). For a stock you don't own: Buy and Credit Buy only.
 */
export function StockSheet({
  open, user, data, stock, holding, onClose, onBack, onBuy, onCreditBuy, onFreeUp,
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
  const [raw, setRaw] = useState("");
  const [all, setAll] = useState(false);
  // What went to JAW's sheet: once the sale lands the shares are re-read, and MAX's free shares are then none.
  const [sold, setSold] = useState(0n);
  const go = (next: Step) => {
    setDirection(ORDER.indexOf(next) > ORDER.indexOf(step) ? "forward" : "back");
    setStep(next);
  };

  const ticker = tickerOf(stock.symbol);
  const owned = holding.freeRaw + holding.lockedRaw > 0n;
  // MAX sells every free share, to the last unit; typed shares go through the token's multiplier.
  const sharesRaw = all ? holding.freeRaw : sharesToRaw(raw, holding.multiplier, stock.decimals);
  const freeShares = rawToShares(holding.freeRaw, holding.multiplier, stock.decimals);

  const quote = useSellQuote(stock, step === "stock" ? 0n : sharesRaw);
  const q = quote.data ?? null;
  // A sale of free shares doesn't touch the loan, so planSell reads no collateral factor for it.
  const plan = q ? planSell({ from: "free", stock, holding, cf: 0, position: data, quote: q }) : null;
  const econ = q ? sellEconomics(q, stock, holding.priceUsd) : null;

  let blocker: string | null = null;
  if (sharesRaw > holding.freeRaw) blocker = SELL_BLOCKED["not-free"];
  else if (sharesRaw > 0n && quote.isSuccess && q === null) blocker = `There’s no market for ${stock.name} right now.`;
  else if (plan?.block) blocker = SELL_BLOCKED[plan.block];
  const warning =
    blocker ?? (plan?.warn ? `You’d get ${(plan.discount * 100).toFixed(1)}% under Aave’s price — the market for ${stock.name} is small.` : null);
  const note = warning ?? (plan?.priceMayMove ? "Stock markets are closed. You can still sell, but the price can jump when they reopen." : null);
  const ready = sharesRaw > 0n && !!plan && q?.amountIn === sharesRaw && !blocker && !quote.isFetching;
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Sell would sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
  const signable =
    open && step === "sell" && ready && plan && q && !feeBlocked
      ? { user, stock, quote: q, plan, oraclePriceUsd: holding.priceUsd, debtRaw: data.debtRaw }
      : null;
  const { sign, phase, error, reset, busy, txHash, checking, blocked } = useSell(signable);

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
          <>
            <StockHeader holding={holding} market={market} />
            {(holding.paused || holding.frozen) && (
              <p role="status" className="m-0 text-[13px] leading-snug text-act">
                {holding.paused
                  ? `Aave has paused ${stock.name} for now: it can’t come out of backing or back new credit.`
                  : `Aave has frozen ${stock.name} for now: it can’t back new credit.`}
              </p>
            )}
            <MarketBanner />
            {owned && <StockPosition holding={holding} />}
            <StockChart holding={holding} name={stock.name} />
            <div className="grid grid-cols-2 gap-2.5">
              <StatCard label="Of your portfolio" value={owned ? `${((portfolioShare(holding.freeUsd + holding.lockedUsd, data.stocksUsd) ?? 0) * 100).toFixed(1)}%` : "0%"} />
              <StatCard label="Aave’s price" value={formatUsd(holding.priceUsd)} />
            </div>
            <Actions
              owned={owned}
              canSell={holding.freeRaw > 0n}
              backs={holding.lockedRaw > 0n}
              paused={holding.paused}
              onBuy={onBuy}
              onSell={() => go("sell")}
              onCreditBuy={onCreditBuy}
              onFreeUp={onFreeUp}
            />
            {owned && holding.freeRaw === 0n && (
              <p className="m-0 px-0.5 text-[13px] leading-snug text-ink-mid">All of it backs credit. Free up shares to sell them.</p>
            )}
            <StockActivity user={user} holding={holding} name={stock.name} owned={owned} />
            <p className="m-0 px-1 text-xs leading-snug text-subtle">
              Values use the price your credit is measured at. The price at the top and the chart are market prices, for information only.
              Tokenized stocks track the share price; they are not company shares and carry no voting rights.
            </p>
          </>
        ) : (
          <>
            <AmountField
              label="You sell"
              source={<AmountSource>Free shares</AmountSource>}
              badge={<StockAvatar symbol={stock.symbol} />}
              unit={ticker}
              decimals={6}
              value={all ? String(Math.floor(freeShares * 1e6) / 1e6) : raw}
              onValue={(v) => {
                setAll(false);
                setRaw(v);
              }}
              onMax={() => setAll(true)}
              hint={`Free: ${formatShares(freeShares)} shares · ${formatUsd(holding.freeUsd)} at Aave’s price`}
              autoFocus
            />
            <AmountArrow />
            <YouGetCash usd={quote.isFetching && sharesRaw > 0n ? null : econ ? econ.usd : 0} priceUsd={econ ? econ.price : holding.priceUsd} />
            <Summary
              rows={[
                { label: "Lowest price", value: plan && !quote.isFetching ? `${formatUsd(floorPriceUsd(plan, stock))} a share` : "…" },
                NETWORK_FEE_ROW,
              ]}
            />
            {note && <p role="status" className={`m-0 text-[13px] leading-snug ${blocker ? "text-act" : "text-watch-text"}`}>{note}</p>}
            {ready && plan && q && <SellSmallPrint stock={stock} holding={holding} quote={q} plan={plan} />}
            {feeBlocked && (
              <p role="alert" className="m-0 text-[13px] text-act">
                Your account can’t pay network fees in USDC on Base right now, so this sale can’t go through.
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
 * NYM's action row in the kit's buttons: Buy and Sell, then Credit Buy (lime, as on Invest) and Free up shares when
 * some back credit. A stock you don't own: Buy and Credit Buy. Send is left out: Leo's allowlist only lets money move
 * between the account's own pockets, and a transfer to someone else can't be pinned to the user.
 */
function Actions({
  owned, canSell, backs, paused, onBuy, onSell, onCreditBuy, onFreeUp,
}: {
  owned: boolean;
  canSell: boolean;
  backs: boolean;
  paused: boolean;
  onBuy: () => void;
  onSell: () => void;
  onCreditBuy: () => void;
  onFreeUp: () => void;
}) {
  const creditBuy = (
    <Button icon={<CreditIcon size={18} strokeWidth={1.8} />} onClick={onCreditBuy} className={owned && !backs ? "col-span-2" : ""}>
      Credit Buy
    </Button>
  );
  if (!owned) {
    return (
      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="white" onClick={onBuy}>Buy</Button>
        {creditBuy}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Button variant="white" onClick={onBuy}>Buy</Button>
      <Button variant="white" onClick={onSell} disabled={!canSell}>Sell</Button>
      {creditBuy}
      {backs && <Button variant="soft" onClick={onFreeUp} disabled={paused}>Free up shares</Button>}
    </div>
  );
}

/**
 * The Sell step's small print (and the Trade sheet's stock → cash): every move in the batch (D7), the lowest price the
 * swap accepts and what the stock is.
 */
export function SellSmallPrint({ stock, holding, quote, plan }: { stock: ReserveAsset; holding: Holding; quote: SellQuote; plan: SellPlan }) {
  const ticker = tickerOf(stock.symbol);
  const shares = formatShares(rawToShares(plan.sharesRaw, holding.multiplier, stock.decimals));
  const floor = formatUsd(floorPriceUsd(plan, stock));
  const venue = VENUE_LABEL[quote.venue];
  return (
    <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
      In one go: exactly {shares} {ticker} is approved for the {venue} router and swapped, and at least{" "}
      {formatUsd(toUsd(plan.minOutRaw))} lands in your cash. If the price falls under {floor} a share, the sale is cancelled,
      so it never sells for more than {SELL_LIMITS.floorBps / 100}% under Aave’s price ({formatUsd(holding.priceUsd)}).{" "}
      {stock.name} here is a tokenized stock. It tracks the share price; it is not company shares or voting rights.
    </p>
  );
}

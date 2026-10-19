"use client";

import { Button } from "../kit/Button";
import { StatCard, StockActivity, StockChart, StockHeader, StockPosition } from "./StockOverview";
import { CreditIcon } from "../kit/icons";
import type { useMarketPrices } from "@/hooks/useMarketPrices";
import type { Holding, PositionData } from "@/hooks/usePosition";
import { formatUsd } from "@/lib/formatting";
import { portfolioShare } from "@/lib/holding";
import type { ReserveAsset } from "@/lib/tokens/registry";

/**
 * The stock itself: its market price and today's move, a pause or freeze, your holding, the actions right under it,
 * the chart, its share of your portfolio and Aave's price, and this stock's moves.
 */
export function StockStep({
  user,
  data,
  stock,
  holding,
  market,
  onBuy,
  onSell,
  onCreditBuy,
  onFreeUp,
}: {
  user: `0x${string}`;
  data: PositionData;
  stock: ReserveAsset;
  holding: Holding;
  market: ReturnType<typeof useMarketPrices>;
  onBuy: () => void;
  onSell: () => void;
  onCreditBuy: () => void;
  onFreeUp: () => void;
}) {
  const owned = holding.freeRaw + holding.backingRaw > 0n;
  const maxRaw = holding.freeRaw;
  return (
    <>
      <StockHeader holding={holding} market={market} />
      {(holding.paused || holding.frozen) && (
        <p role="status" className="m-0 text-[13px] leading-snug text-act">
          {holding.paused
            ? `Aave has paused ${stock.name} for now: it can’t come out of backing or back new credit.`
            : `Aave has frozen ${stock.name} for now: it can’t back new credit.`}
        </p>
      )}
      {owned && <StockPosition holding={holding} />}
      {/* UX note 9: the actions sit right under the holding card, not under the chart and stats. */}
      <Actions
        owned={owned}
        canSell={maxRaw > 0n}
        backs={holding.backingRaw > 0n}
        paused={holding.paused}
        onBuy={onBuy}
        onSell={onSell}
        onCreditBuy={onCreditBuy}
        onFreeUp={onFreeUp}
      />
      {owned && maxRaw === 0n && (
        <p className="m-0 px-0.5 text-[13px] leading-snug text-ink-mid">
          All of it backs your credit right now. Repay some first to sell.
        </p>
      )}
      <StockChart holding={holding} name={stock.name} />
      <div className="grid grid-cols-2 gap-2.5">
        <StatCard
          label="Of my portfolio"
          value={
            owned
              ? `${((portfolioShare(holding.freeUsd + holding.backingUsd, data.stocksUsd) ?? 0) * 100).toFixed(1)}%`
              : "0%"
          }
        />
        <StatCard label="Aave’s price" value={formatUsd(holding.priceUsd)} />
      </div>
      <StockActivity user={user} holding={holding} name={stock.name} owned={owned} />
      <p className="m-0 px-1 text-xs leading-snug text-subtle">
        Values use the price your credit is measured at. The price at the top and the chart are market prices, for
        information only. Tokenized stocks track the share price; they are not company shares and carry no voting
        rights.
      </p>
    </>
  );
}

/**
 * NYM's action row in the kit's buttons: Buy and Sell, then Credit Buy (lime, as on Invest) and Free up shares when
 * some back credit. A stock you don't own: Buy and Credit Buy. Send is left out: Leo's allowlist only lets money move
 * between the account's own pockets, and a transfer to someone else can't be pinned to the user.
 */
function Actions({
  owned,
  canSell,
  backs,
  paused,
  onBuy,
  onSell,
  onCreditBuy,
  onFreeUp,
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
    <Button
      icon={<CreditIcon size={18} strokeWidth={1.8} />}
      onClick={onCreditBuy}
      className={owned && !backs ? "col-span-2" : ""}
    >
      Credit Buy
    </Button>
  );
  if (!owned) {
    return (
      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="white" onClick={onBuy}>
          Buy
        </Button>
        {creditBuy}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Button variant="white" onClick={onBuy}>
        Buy
      </Button>
      <Button variant="white" onClick={onSell} disabled={!canSell}>
        Sell
      </Button>
      {creditBuy}
      {backs && (
        <Button variant="soft" onClick={onFreeUp} disabled={paused}>
          Free up shares
        </Button>
      )}
    </div>
  );
}

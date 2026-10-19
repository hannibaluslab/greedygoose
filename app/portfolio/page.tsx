"use client";

import { useSearchParams } from "next/navigation";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { TabHeader } from "@/components/gg/Screen";
import { BalanceHero, TodayChange, TodayPending } from "@/components/gg/home/BalanceHero";
import { Button } from "@/components/gg/kit/Button";
import { useMoneySheets } from "@/components/gg/cash/MoneySheets";
import { StockSheets, useStockSheets } from "@/components/gg/stock/StockSheets";
import { HoldingList, HoldingRow } from "@/components/gg/stock/Holding";
import { ValueLine } from "@/components/gg/ValueLine";
import { CreditIcon, MarketIcon, TradeIcon } from "@/components/gg/kit/icons";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { useMarketPrices } from "@/hooks/useMarketPrices";
import { useStockGain } from "@/hooks/useStockGain";
import { useBackingFactorsRead, usePosition, type PositionData } from "@/hooks/usePosition";
import { floorCents, formatUsd, formatUsdTrim } from "@/lib/formatting";
import { MIN_BACKING_USD, backingOptions, creditAvailable } from "@/lib/creditBuy";
import { maxSpendRaw, toUsd } from "@/lib/cash";
import { dayChange } from "@/lib/prices/market";
import { RetryButton } from "@/components/gg/kit/RetryButton";

export default function PortfolioPage() {
  return <RequireAccount>{(address) => <Portfolio address={address} />}</RequireAccount>;
}

/**
 * Design board "10 · Portfolio (Invest tab)" (PortfolioPage.dc.html). Market opens Flow 1's sheet
 * (F1-3 → the stock's sheet → F1-4 → confirm); /buy lands here with ?market, or ?s=SYMBOL for one stock's Buy
 * step. Trade, between Market and Credit Buy (Adrian), opens the Trade sheet, as Home's Trade does. Credit Buy opens
 * Flow 2's sheet (F2-2 → F2-3 … F2-6). A holding row opens its stock's sheet. The status pill opens the Repay sheet,
 * the one credit sheet (Adrian, 2026-10-15; the board's Credit sheet, HomeCreditSlide, is gone).
 * Today's change and each row's day come from market prices (plan item 8); the gain line under the hero from Aave's
 * prices on what was held at each day's end (useStockGain), with the markets-closed banner under it at weekends. Not
 * drawn yet: "Your mix" (the Rebalancer, item 9).
 */
function Portfolio({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  const params = useSearchParams();
  const stocks = useStockSheets(
    params.has("s") ? { symbol: params.get("s") } : params.has("market") ? { symbol: null } : null,
  );
  const money = useMoneySheets();

  return (
    <div className="relative min-h-dvh">
      <div className="flex flex-col gap-4 px-5 pt-[calc(env(safe-area-inset-top)+12px)]">
        <TabHeader title="Investments" back="/home" status={data?.status} onStatus={() => money.repay()} />

        {isError && !data ? (
          <div className="rounded-[22px] bg-card p-4 shadow-card-elev">
            <p role="alert" className="m-0 text-[15px]">
              We couldn’t load your account from Base.
            </p>
            <div className="mt-3">
              <RetryButton onClick={() => void refetch()} />
            </div>
          </div>
        ) : !data ? (
          <div aria-busy className="h-[300px] animate-pulse rounded-[22px] bg-chip" />
        ) : (
          <Loaded
            address={address}
            data={data}
            openMarket={stocks.openMarket}
            openTrade={() => stocks.openTrade()}
            openCreditBuy={stocks.openCreditBuy}
            openStock={stocks.openStock}
          />
        )}
      </div>
      <TabBar />
      {data && <StockSheets sheets={stocks} user={address} data={data} />}
    </div>
  );
}

function Loaded({
  address,
  data,
  openMarket,
  openTrade,
  openCreditBuy,
  openStock,
}: {
  address: `0x${string}`;
  data: PositionData;
  openMarket: () => void;
  openTrade: () => void;
  openCreditBuy: () => void;
  openStock: (symbol: string) => void;
}) {
  const held = data.holdings.filter((h) => h.freeShares + h.backingShares > 0);
  const power = useBuyingPower(data, held.length > 0);
  const market = useMarketPrices(held);
  const priced = held.map((h) => ({ valueUsd: h.freeUsd + h.backingUsd, ...market.bySymbol[h.symbol] }));
  const today = dayChange(priced, data.stocksUsd);
  const gain = useStockGain(address, data.holdings);
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <BalanceHero
          // Half the width for the portfolio, half for buying power (Adrian: more width for the portfolio).
          even
          label="Stocks"
          value={data.stocksUsd}
          sub={today ? <TodayChange usd={today.usd} pct={today.pct} /> : market.loading ? <TodayPending /> : undefined}
          // Buying power (Adrian): the cash you can spend plus the credit one Credit Buy can use, the same figure the Credit
          // Buy sheet opens on. To the cent, rounded down, so it's never more than there is (ruling 7).
          side={{
            label: "Buying power",
            // The "$" drawn as the portfolio's (as on Home): smaller, in the mid ink.
            value: power ? (
              <>
                <span className="text-[22px] font-medium tracking-normal text-ink-mid">$</span>
                {formatUsd(floorCents(power.cashUsd + power.creditUsd)).replace("$", "")}
              </>
            ) : (
              "–"
            ),
            sub: power ? (
              // One line (Adrian): the total is above, so this only says what's in it.
              <span className="whitespace-nowrap">
                {power.creditUsd >= 0.01 ? `Cash + ${formatUsdTrim(floorCents(power.creditUsd))} credit` : "Cash only"}
              </span>
            ) : undefined,
          }}
        />
        {held.length > 0 && (
          // The gain line (Adrian, 2026-10-19): price moves only, on what was held at each day's end, so a buy never
          // reads as a gain and today's stocks are never drawn back over the week.
          <ValueLine
            points={gain.series}
            height={34}
            loading={gain.loading}
            onRetry={gain.retry}
            label="What your stocks gained or lost over the last 7 days, from price moves on what you held at each day's end"
            caption="Gain or loss · 7 days"
            neutral={!!gain.series && gain.series.every((v) => v === 0)}
            zero
            unavailable="Your stocks’ week isn’t available right now."
          />
        )}
        <MarketBanner />
      </section>

      {/* The board's pills (52px, 15px labels with 18px icons), 8px apart, Trade between. Trade's short label takes the
          narrowest cell and Credit Buy the widest, so its label fits on a small phone. */}
      <div className="grid grid-cols-[1fr_0.82fr_1.18fr] gap-2">
        <Button variant="white" size="row" icon={<MarketIcon size={18} strokeWidth={1.8} />} onClick={openMarket}>
          Market
        </Button>
        <Button variant="white" size="row" icon={<TradeIcon size={18} strokeWidth={1.8} />} onClick={openTrade}>
          Trade
        </Button>
        <Button size="row" icon={<CreditIcon size={18} strokeWidth={1.8} />} onClick={openCreditBuy}>
          Credit Buy
        </Button>
      </div>

      <HoldingList title="My holdings">
        {held.length === 0 ? (
          <p className="m-0 py-4 text-[15px]">
            You don’t hold any supported stocks yet.{" "}
            <button type="button" onClick={openMarket} className="font-semibold underline">
              Buy stocks
            </button>
          </p>
        ) : (
          held.map((h) => {
            const value = h.freeUsd + h.backingUsd;
            const backs = value > 0 ? h.backingUsd / value : 0;
            const m = market.bySymbol[h.symbol];
            return (
              <HoldingRow
                key={h.symbol}
                symbol={h.symbol}
                name={h.name}
                valueUsd={value}
                shares={h.freeShares + h.backingShares}
                priceUsd={h.priceUsd}
                backs={backs}
                today={m?.change}
                spark={m?.day}
                onClick={() => openStock(h.symbol)}
                note={h.paused || h.frozen ? "Aave has paused this stock for now." : undefined}
              />
            );
          })
        )}
      </HoldingList>
      <p className="m-0 px-1 text-xs leading-snug text-subtle">
        Values use the prices your credit is measured at. Today’s change and the lines use market prices, for
        information only.
      </p>
    </>
  );
}

/** Cash you can spend (less the network-fee buffer) and the credit one Credit Buy can use; null while the backing reads. */

function useBuyingPower(data: PositionData, holdsStock: boolean) {
  const cfs = useBackingFactorsRead(data.holdings).cfs;
  if (holdsStock && !cfs) return null;
  const options = cfs ? backingOptions(data.holdings, cfs).filter((o) => o.freeUsd >= MIN_BACKING_USD) : [];
  const credit = creditAvailable({ position: data, options, cash: data.cash, holdsStock });
  return { cashUsd: toUsd(maxSpendRaw(data.cash)), creditUsd: credit.usd };
}

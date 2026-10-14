"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { TabHeader } from "@/components/gg/Screen";
import { BalanceHero, TodayChange, TodayPending } from "@/components/gg/BalanceHero";
import { Button } from "@/components/gg/Button";
import { BuySheet } from "@/components/gg/BuySheet";
import { CreditBuySheet } from "@/components/gg/CreditBuySheet";
import { CreditSheet } from "@/components/gg/CreditSheet";
import { HoldingList, HoldingRow } from "@/components/gg/Holding";
import { ValueLine } from "@/components/gg/ValueLine";
import { CreditIcon, TradeIcon } from "@/components/gg/icons";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { useMarketPrices } from "@/hooks/useMarketPrices";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { useSheetSubject } from "@/hooks/useSheetSubject";
import { aprToApy } from "@/lib/aave/math";
import { formatUsd } from "@/lib/formatting";
import { dayChange, weekValue } from "@/lib/prices/market";

export default function PortfolioPage() {
  return <RequireAccount>{(address) => <Portfolio address={address} />}</RequireAccount>;
}

/**
 * Design board "10 · Portfolio (Invest tab)" (PortfolioPage.dc.html). Market opens Flow 1's sheet
 * (F1-3 → F1-4 → confirm); /buy lands here with ?market, or ?s=SYMBOL for one stock's Buy step. Credit Buy
 * opens Flow 2's sheet (F2-2 → F2-3 … F2-6). The status pill opens the Credit sheet (HomeCreditSlide).
 * Today's change, the value line and each row's day come from market prices (plan item 8), with the
 * markets-closed banner under the line at weekends. Not drawn yet: "Your mix" (the Rebalancer, item 9).
 */
function Portfolio({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  const params = useSearchParams();
  const market = useSheetSubject<{ symbol: string | null }>(
    params.has("s") ? { symbol: params.get("s") } : params.has("market") ? { symbol: null } : null,
  );
  const openMarket = () => market.show({ symbol: null });
  const [creditBuy, setCreditBuy] = useState(false);
  const [credit, setCredit] = useState(false);

  return (
    <div className="relative min-h-dvh">
      <div className="flex flex-col gap-4 px-5 pt-[58px]">
        <TabHeader title="Portfolio" back="/home" status={data?.status} onStatus={() => setCredit(true)} />

        {isError && !data ? (
          <div className="rounded-[22px] bg-card p-4 shadow-card-elev">
            <p role="alert" className="m-0 text-[15px]">We couldn’t load your account from Base.</p>
            <button type="button" onClick={() => refetch()} className="mt-3 h-11 rounded-full bg-chip px-4 font-semibold">
              Try again
            </button>
          </div>
        ) : !data ? (
          <div aria-busy className="h-[300px] animate-pulse rounded-[22px] bg-chip" />
        ) : (
          <Loaded data={data} openMarket={openMarket} openCreditBuy={() => setCreditBuy(true)} />
        )}
      </div>
      <TabBar />
      {data && market.subject && (
        <BuySheet key={market.key} open={market.open} user={address} data={data} symbol={market.subject.symbol} onClose={market.close} />
      )}
      {data && <CreditBuySheet open={creditBuy} user={address} data={data} onClose={() => setCreditBuy(false)} />}
      {data && (
        <CreditSheet
          open={credit}
          onClose={() => setCredit(false)}
          account={address}
          data={data}
          // The Market is already on this page: Buy more swaps the sheets instead of navigating to itself.
          onBuyMore={() => {
            setCredit(false);
            openMarket();
          }}
        />
      )}
    </div>
  );
}

function Loaded({ data, openMarket, openCreditBuy }: { data: PositionData; openMarket: () => void; openCreditBuy: () => void }) {
  const held = data.holdings.filter((h) => h.freeShares + h.lockedShares > 0);
  const market = useMarketPrices(held);
  const priced = held.map((h) => ({ valueUsd: h.freeUsd + h.lockedUsd, ...market.bySymbol[h.symbol] }));
  const today = dayChange(priced, data.stocksUsd);
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <BalanceHero
          label="Portfolio"
          value={data.stocksUsd}
          sub={today ? <TodayChange usd={today.usd} pct={today.pct} /> : market.loading ? <TodayPending /> : undefined}
          side={{
            label: "Cash available",
            // Whole dollars, as drawn ("$400"), and never more than there is.
            value: formatUsd(Math.floor(data.cashUsd)).replace(/\.00$/, ""),
            sub: <><span className="font-semibold text-pos">{(aprToApy(data.savingsApr) * 100).toFixed(1)}%</span> APY</>,
          }}
        />
        {held.length > 0 && <ValueLine points={weekValue(priced)} height={34} loading={market.loading} onRetry={market.retry} />}
        <MarketBanner />
      </section>

      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="white" icon={<TradeIcon size={18} strokeWidth={1.8} />} onClick={openMarket}>Market</Button>
        <Button icon={<CreditIcon size={18} strokeWidth={1.8} />} onClick={openCreditBuy}>Credit Buy</Button>
      </div>

      <HoldingList title="Your holdings">
        {held.length === 0 ? (
          <p className="m-0 py-4 text-[15px]">
            You don’t hold any supported stocks yet.{" "}
            <button type="button" onClick={openMarket} className="font-semibold underline">Buy stocks</button>
          </p>
        ) : (
          held.map((h) => {
            const value = h.freeUsd + h.lockedUsd;
            const backs = value > 0 ? h.lockedUsd / value : 0;
            const m = market.bySymbol[h.symbol];
            return (
              <HoldingRow
                key={h.symbol}
                symbol={h.symbol}
                name={h.name}
                valueUsd={value}
                shares={h.freeShares + h.lockedShares}
                backs={backs}
                today={m?.change}
                spark={m?.day}
                href={backs > 0 ? `/free-up?s=${h.symbol}` : "/use-credit"}
                note={h.paused || h.frozen ? "Aave has paused this stock for now." : undefined}
              />
            );
          })
        )}
      </HoldingList>
      <p className="m-0 px-1 text-xs leading-snug text-subtle">
        Values use Aave’s prices. Today’s change and the lines use market prices, for information only. Tokenized stocks track the share price; they are not company shares and carry no voting rights.
      </p>
    </>
  );
}

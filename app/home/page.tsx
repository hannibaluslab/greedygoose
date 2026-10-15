"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Header } from "@/components/gg/Header";
import { TabBar } from "@/components/gg/TabBar";
import { BalanceHero, TodayChange, TodayPending } from "@/components/gg/BalanceHero";
import { QuickAction } from "@/components/gg/QuickAction";
import { CashCard, YieldCard } from "@/components/gg/Cards";
import { StartEarningCard, TurnIntoCash } from "@/components/gg/CashSetup";
import { AddStockCard, HoldingCard } from "@/components/gg/Holding";
import { CreditSheet } from "@/components/gg/CreditSheet";
import { CashSheet } from "@/components/gg/CashSheet";
import { StockSheets, useStockSheets } from "@/components/gg/StockSheets";
import { ValueLine } from "@/components/gg/ValueLine";
import { TotalBalanceSheet, YieldSheet } from "@/components/gg/InfoSheets";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { ChevronRight, CreditIcon, PlusIcon, RepayIcon, TradeIcon } from "@/components/gg/icons";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { useCashSetup } from "@/hooks/useCashSetup";
import { useEntryBalances } from "@/hooks/useEntryBalances";
import { useMarketPrices } from "@/hooks/useMarketPrices";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { arrivedCoins, arrivedView, rateText, startEarningShown, type ArrivedView } from "@/lib/cashSetup";
import { homeStatus } from "@/lib/risk/status";
import { StatusPill } from "@/components/gg/Status";
import { formatUsdTrim } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";
import { dayChange, weekValue } from "@/lib/prices/market";

export default function HomePage() {
  return <RequireAccount>{(address) => <Home address={address} />}</RequireAccount>;
}

type Sheet = "total" | "yield" | "credit" | "cash";

/**
 * Design board "2 · Home · portfolio: Rail" (HomeUpliftRail.dc.html), with its sheets: Total balance (HomeInfo),
 * Average yield (HomeYieldInfo) and Credit (HomeCreditSlide). Today's change, the line and each holding's day come
 * from market prices (plan item 8). The board's all-time return is left out: it needs what Sam paid, which only the
 * PnL engine will read from the chain (plan item 7). A holding card opens its stock's sheet.
 *
 * Earning and other dollars becoming cash run under the hood (D20): a small card asks to finish setting up while the
 * account has no Save grant, and other dollars that nothing converts get "Turn into cash". Once they convert on their
 * own, the Cash card only says they're arriving.
 */
function Home({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const stocks = useStockSheets();
  const close = () => setSheet(null);
  const apy = data ? aprToApy(data.savingsApr) : 0;
  const setup = useCashSetup(address);
  const arrived = arrivedView(arrivedCoins(useEntryBalances(address)), setup.entry);

  return (
    <div className="relative flex min-h-dvh flex-col">
      <Header address={address} />

      {isError && !data && (
        <div className="mx-5 mt-4 rounded-[22px] bg-card p-4 shadow-card-elev">
          <p role="alert" className="m-0 text-[15px]">We couldn’t load your account from Base.</p>
          <button type="button" onClick={() => refetch()} className="mt-3 h-11 rounded-full bg-chip px-4 font-semibold">
            Try again
          </button>
        </div>
      )}

      {!data ? (
        <Skeleton />
      ) : (
        <Loaded
          data={data}
          apy={apy}
          open={setSheet}
          openStock={stocks.openStock}
          arrived={arrived}
          dim={startEarningShown(setup.save, data.cashUsd)}
          cards={
            <>
              <TurnIntoCash user={address} view={arrived} setup={setup} />
              {startEarningShown(setup.save, data.cashUsd) && (
                <StartEarningCard
                  cashUsd={data.cashUsd}
                  rate={rateText(apy)}
                  grant={setup.earning}
                  onStart={() => setup.startEarning(() => toast.success(`Your cash starts earning ${rateText(apy)}`))}
                />
              )}
            </>
          }
        />
      )}

      <TabBar />
      {data && (
        <>
          <TotalBalanceSheet open={sheet === "total"} onClose={close} cashUsd={data.cashUsd} stocksUsd={data.stocksUsd} debtUsd={data.debtUsd} />
          <YieldSheet open={sheet === "yield"} onClose={close} cashUsd={data.cashUsd} savingsUsd={data.savingsUsd} apy={apy} earning={data.cash.saveOn} />
          <CreditSheet open={sheet === "credit"} onClose={close} account={address} data={data} />
          <CashSheet open={sheet === "cash"} onClose={close} account={address} data={data} apy={apy} arrived={arrived} save={setup.save} />
          <StockSheets sheets={stocks} user={address} data={data} />
        </>
      )}
    </div>
  );
}

function Loaded({
  data, apy, open, openStock, arrived, cards, dim,
}: {
  data: PositionData;
  apy: number;
  open: (sheet: Sheet) => void;
  openStock: (symbol: string) => void;
  arrived: ArrivedView;
  /** What needs the user about their cash: other dollars to turn into cash, starting to earn. */
  cards: ReactNode;
  /** Board 2g: money is in but doesn't earn yet, so Cash and Yield sit faded under "Start earning". */
  dim: boolean;
}) {
  const held = data.holdings.filter((h) => h.freeShares + h.lockedShares > 0);
  const market = useMarketPrices(held);
  const priced = held.map((h) => ({ valueUsd: h.freeUsd + h.lockedUsd, ...market.bySymbol[h.symbol] }));
  const today = dayChange(priced, data.stocksUsd + data.cashUsd);

  return (
    <>
      <section className="flex flex-col gap-2.5 px-5 pt-[18px]">
        <BalanceHero
          label="Total balance"
          info={{ label: "What’s in your total balance", onClick: () => open("total") }}
          value={data.stocksUsd + data.cashUsd}
          sub={today ? <TodayChange usd={today.usd} pct={today.pct} /> : market.loading ? <TodayPending /> : undefined}
          // Board 2f: what you have on the left, what you owe on the right. Owed is rounded up, never shown as less.
          side={{
            label: "Credit",
            info: { label: "Your credit", onClick: () => open("credit") },
            value: formatUsdTrim(Math.ceil(data.debtUsd)),
            unit: "owed",
            sub:
              data.debtUsd > 0 ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <StatusPill status={homeStatus(data.status)} size="sm" />
                  {formatUsdTrim(data.monthlyCostUsd)} / month
                </span>
              ) : (
                <span className="text-subtle">None taken</span>
              ),
          }}
        />
        {held.length > 0 && <ValueLine points={weekValue(priced)} height={68} loading={market.loading} onRetry={market.retry} />}
        <MarketBanner />
      </section>

      <section className="grid grid-cols-4 gap-2 px-5 pt-[22px]">
        <QuickAction href="/buy" label="Trade" icon={<TradeIcon />} />
        <QuickAction href="/receive" label="Top up" icon={<PlusIcon />} />
        <QuickAction onClick={() => open("credit")} label="Credit Buy" icon={<CreditIcon />} />
        <QuickAction href="/repay" label="Repay" icon={<RepayIcon />} />
      </section>

      <section className="flex flex-col gap-2.5 px-5 pt-[18px] empty:hidden">{cards}</section>

      <section className="grid grid-cols-2 gap-2.5 px-5 pt-[18px]">
        <CashCard
          cashUsd={data.cashUsd}
          earning={data.cash.saveOn}
          dim={dim}
          note={arrived.kind === "arriving" ? `${arrived.text} arriving` : undefined}
          onClick={() => open("cash")}
        />
        <YieldCard apy={apy} dim={dim} onClick={() => open("yield")} />
      </section>

      {/* With no stocks, the empty state takes the room down to the tab bar. */}
      <section className={`flex flex-col gap-2.5 px-5 pt-[17px] leading-[normal] ${held.length === 0 ? "grow" : ""}`}>
        <div className="flex h-[22px] items-center justify-between">
          <Link href="/portfolio" className="flex items-baseline gap-2 no-underline">
            <span className="text-lg font-semibold tracking-[-0.015em]">Portfolio</span>
            <span className="num text-sm text-subtle">{formatUsdTrim(Math.round(data.stocksUsd))}</span>
          </Link>
          <Link href="/portfolio" className="-my-[5px] -mr-1 flex h-8 items-center gap-0.5 px-1 text-[13px] font-medium text-ink-mid no-underline">
            See all <ChevronRight />
          </Link>
        </div>
        {held.length === 0 ? (
          <EmptyPortfolio />
        ) : (
          <div className={`-mx-5 flex ${held.length < 2 ? "justify-start" : "justify-between"} gap-2 overflow-x-auto px-5 pb-4 pt-0.5 [scrollbar-width:none]`}>
            {held.map((h) => {
              const valueUsd = h.freeUsd + h.lockedUsd;
              const m = market.bySymbol[h.symbol];
              return (
                <HoldingCard
                  key={h.symbol}
                  symbol={h.symbol}
                  name={h.name}
                  valueUsd={valueUsd}
                  backs={valueUsd > 0 ? h.lockedUsd / valueUsd : 0}
                  today={m?.change}
                  spark={m?.day}
                  pending={market.loading}
                  shares={h.freeShares + h.lockedShares}
                  onClick={() => openStock(h.symbol)}
                />
              );
            })}
            {held.length < 3 && <AddStockCard href="/buy" />}
          </div>
        )}
      </section>
    </>
  );
}

function Skeleton() {
  return (
    <div aria-busy className="flex flex-col gap-4 px-5 pt-[18px]">
      <div className="h-[92px] animate-pulse rounded-[22px] bg-chip" />
      <div className="grid grid-cols-4 gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="mx-auto size-12 animate-pulse rounded-3xl bg-chip" />)}</div>
      <div className="grid grid-cols-2 gap-2.5"><div className="h-[108px] animate-pulse rounded-[22px] bg-chip" /><div className="h-[108px] animate-pulse rounded-[22px] bg-chip" /></div>
      <div className="h-[170px] animate-pulse rounded-[22px] bg-chip" />
    </div>
  );
}

/**
 * Home's portfolio before the first stock: the board's dashed "add a stock" language, grown to fill the room down to
 * the tab bar, with the seven stocks you can buy. No button of its own (Adrian): Top up and Trade sit above it.
 */
function EmptyPortfolio() {
  return (
    <div className="mb-4 flex min-h-[200px] grow flex-col items-center justify-center gap-4 rounded-[22px] border-[1.5px] border-dashed border-[rgba(14,13,11,0.2)] px-6 py-6 text-center">
      <div aria-hidden className="flex gap-1">
        {EQUITIES.map((e) => (
          <StockAvatar key={e.symbol} symbol={e.symbol} size={38} />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[17px] font-semibold tracking-[-0.01em]">You don’t hold any stocks yet</p>
        <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">{EQUITIES.map((e) => e.name).join(", ")}.</p>
      </div>
    </div>
  );
}

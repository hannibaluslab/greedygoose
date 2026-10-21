"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Header } from "@/components/gg/home/Header";
import { TabBar } from "@/components/gg/TabBar";
import { AllTimeChange, BalanceHero, TodayChange, TodayPending } from "@/components/gg/home/BalanceHero";
import { QuickAction } from "@/components/gg/home/QuickAction";
import { CashCard, YieldCard } from "@/components/gg/home/Cards";
import { LiveEarning } from "@/components/gg/home/LiveEarning";
import { useTotalEarned, type TotalEarned } from "@/hooks/useTotalEarned";
import { usePnl } from "@/hooks/usePnl";
import {
  ArrivedCard,
  ConvertedSheet,
  FuelTankCard,
  StartEarningCard,
  useTurnIntoCash,
} from "@/components/gg/cash/CashSetup";
import { AddStockCard, HoldingCard } from "@/components/gg/stock/Holding";
import { CashSheet } from "@/components/gg/cash/CashSheet";
import { useMoneySheets } from "@/components/gg/cash/MoneySheets";
import { StockSheets, useStockSheets } from "@/components/gg/stock/StockSheets";
import { HeroLine } from "@/components/gg/home/HeroLine";
import { StatusSheet } from "@/components/gg/CreditStatusSheet";
import { LeverageSheet, TotalBalanceSheet, YieldSheet } from "@/components/gg/InfoSheets";
import { StockAvatar } from "@/components/gg/kit/StockAvatar";
import { ChevronRight, CreditIcon, PlusIcon, RepayIcon, TradeIcon } from "@/components/gg/kit/icons";
import { useCashSetup } from "@/hooks/useCashSetup";
import { useStartEarning } from "@/hooks/useStartEarning";
import { useCashCoinBalances } from "@/hooks/useCashCoinBalances";
import { useMarketPrices } from "@/hooks/useMarketPrices";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { arrivedCoins, arrivedView, rateText, type ArrivedView } from "@/lib/cashSetup";
import { homeStatus } from "@/lib/risk/status";
import { leverageOf, leverageText } from "@/lib/leverage";
import { toast } from "sonner";
import { StatusPill } from "@/components/gg/Status";
import { cashWithoutTankUsd, tankLevelUsd, tankLow } from "@/lib/fuelTank";
import { useFillTank } from "@/hooks/useFillTank";
import { ceilCents, formatUsd, formatUsdTrim, monthlyCostText } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";
import { dayChange, weekValue } from "@/lib/prices/market";
import { RetryButton } from "@/components/gg/kit/RetryButton";

export default function HomePage() {
  return <RequireAccount>{(address) => <Home address={address} />}</RequireAccount>;
}

type Sheet = "total" | "yield" | "cash" | "leverage" | "status";

/**
 * Design board "2 · Home · portfolio: Rail" (HomeUpliftRail.dc.html), with its sheets: Total balance (HomeInfo) and
 * Average yield (HomeYieldInfo). The ⓘ beside Credit opens the Repay sheet, the one credit sheet (Adrian, 2026-10-15;
 * the board's Credit sheet, HomeCreditSlide, is gone). Today's change, the line and each holding's day come
 * from market prices (plan item 8). The board's all-time return is left out: it needs what Sam paid, which only the
 * PnL engine will read from the chain (plan item 7). A holding card opens its stock's sheet.
 *
 * Earning and other dollars becoming cash run under the hood (D20): while the wallet's cash isn't earning, a small card
 * offers Start earning, which puts it in savings in one batch (and asks for the Save grant after it, with an executor
 * and none yet), and other dollars that nothing converts get "Turn into cash". Once they convert on their own, the
 * Cash card only says they're arriving.
 */
function Home({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  const earned = useTotalEarned(address);
  // All-time P&L: off until Alchemy's key is set (usePnl), and Home then shows today's change as before.
  const pnl = usePnl(address, data ? data.cashUsd + data.stocksUsd - data.debtUsd : undefined);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const stocks = useStockSheets();
  const close = () => setSheet(null);
  const apy = data ? aprToApy(data.savingsApr) : 0;
  const setup = useCashSetup(address);
  const arrived = arrivedView(arrivedCoins(useCashCoinBalances(address)), setup.entry);
  // Other dollars to turn into cash wait in the menu, with a number over its button (Adrian, 2026-10-20). Their state
  // lives here, so closing the menu while JAW's sheet confirms loses nothing; the card prepares only while it shows.
  const [menuOpen, setMenuOpen] = useState(false);
  const convert = useTurnIntoCash(address, arrived, setup, menuOpen);
  // The fuel tank under half full waits there too: "Fill up" brings it back from savings (Adrian, 2026-10-20).
  const fill = useFillTank(address, data?.cash, menuOpen);
  const low = !!data && tankLow(data.cash) && fill.phase !== "pending";
  const converts = arrived.kind === "ask" && !convert.held;
  const earn = useStartEarning({
    account: address,
    cash: data?.cash,
    savingsUsd: data?.savingsUsd ?? 0,
    setup,
    rate: data ? rateText(apy) : null,
  });

  return (
    <div className="relative flex min-h-dvh flex-col">
      <Header
        address={address}
        aside={data && <LeverageTag data={data} onOpen={() => setSheet("leverage")} />}
        menu={{
          open: menuOpen,
          onOpenChange: setMenuOpen,
          // Each tap goes to JAW's sheet, and the menu closes behind it: "It's cash now" opens over Home once it lands.
          top: (convert.card || low) && (
            <>
              {convert.card && (
                <ArrivedCard
                  {...convert.card}
                  onConvert={() => {
                    convert.card?.onConvert();
                    setMenuOpen(false);
                  }}
                />
              )}
              {low && data && (
                <FuelTankCard
                  levelUsd={tankLevelUsd(data.cash.walletRaw)}
                  phase={fill.phase}
                  checking={fill.checking}
                  blocked={fill.blocked}
                  error={fill.error}
                  preview={setup.preview}
                  onFill={() => {
                    fill.fill();
                    setMenuOpen(false);
                  }}
                />
              )}
            </>
          ),
          waiting: (converts ? 1 : 0) + (low ? 1 : 0),
        }}
      />
      <ConvertedSheet open={convert.landed} held={convert.held} txHash={convert.txHash} onClose={convert.close} />

      {isError && !data && (
        <div className="mx-5 mt-4 rounded-[22px] bg-card p-4 shadow-card-elev">
          <p role="alert" className="m-0 text-[15px]">
            We couldn’t load your account from Base.
          </p>
          <div className="mt-3">
            <RetryButton onClick={() => void refetch()} />
          </div>
        </div>
      )}

      {!data ? (
        <Skeleton />
      ) : (
        <Loaded
          data={data}
          earned={earned.data}
          pnl={pnl}
          apy={apy}
          open={setSheet}
          openStock={stocks.openStock}
          openCreditBuy={stocks.openCreditBuy}
          openTrade={() => stocks.openTrade()}
          arrived={arrived}
          dim={earn.visible}
          cards={
            <>
              {earn.visible && (
                <StartEarningCard
                  title={earn.title}
                  line={earn.line}
                  phase={earn.phase}
                  checking={earn.checking}
                  blocked={earn.blocked}
                  note={earn.note}
                  error={earn.error}
                  preview={earn.preview}
                  onStart={earn.start}
                />
              )}
            </>
          }
        />
      )}

      <TabBar />
      {data && (
        <>
          <TotalBalanceSheet
            open={sheet === "total"}
            onClose={close}
            cashUsd={data.cashUsd}
            stocksUsd={data.stocksUsd}
            debtUsd={data.debtUsd}
          />
          <StatusSheet
            open={sheet === "status"}
            onClose={close}
            status={data.debtRaw > 0n ? homeStatus(data.status) : "none"}
            data={data}
          />
          <LeverageSheet
            open={sheet === "leverage"}
            onClose={close}
            holdUsd={data.stocksUsd + data.cashUsd}
            owedUsd={data.debtUsd}
            status={data.status}
            healthFactor={data.healthFactor}
          />
          <YieldSheet
            open={sheet === "yield"}
            onClose={close}
            cashUsd={data.cashUsd}
            savingsUsd={data.savingsUsd}
            apy={apy}
            apr={data.savingsApr}
            earning={data.cash.saveOn}
            earned={earned.data}
          />
          <CashSheet
            open={sheet === "cash"}
            onClose={close}
            account={address}
            data={data}
            apy={apy}
            arrived={arrived}
            save={setup.save}
          />
          <StockSheets sheets={stocks} user={address} data={data} />
        </>
      )}
    </div>
  );
}

function Loaded({
  data,
  earned,
  pnl,
  apy,
  open,
  openStock,
  openCreditBuy,
  openTrade,
  arrived,
  cards,
  dim,
}: {
  data: PositionData;
  /** What the cash has earned, all time, and when Base was read for it: the Yield card counts on from it. */
  earned: TotalEarned | undefined;
  /** All-time P&L (usePnl): `on` only with Alchemy's key; `data` once it's added up. */
  pnl: ReturnType<typeof usePnl>;
  apy: number;
  open: (sheet: Sheet) => void;
  openStock: (symbol: string) => void;
  /** The Credit Buy quick action: F2-3, the same sheet as Invest's (StockSheets). */
  openCreditBuy: () => void;
  /** The Trade sheet: swap between anything you hold, not the Market. */
  openTrade: () => void;
  arrived: ArrivedView;
  /** What needs the user about their cash: other dollars to turn into cash, starting to earn. */
  cards: ReactNode;
  /** Board 2g: the wallet's cash doesn't earn yet, so Cash and Yield sit faded under "Start earning" (the card's rule). */
  dim: boolean;
}) {
  const held = data.holdings.filter((h) => h.freeShares + h.backingShares > 0);
  const market = useMarketPrices(held);
  const priced = held.map((h) => ({ valueUsd: h.freeUsd + h.backingUsd, ...market.bySymbol[h.symbol] }));
  const today = dayChange(priced, data.stocksUsd + data.cashUsd);
  const money = useMoneySheets();
  const shownStatus = data.debtRaw > 0n ? homeStatus(data.status) : "none";
  const allTime = pnl.on ? pnl.data : undefined;
  const pnlReading = pnl.on && pnl.data === undefined && !pnl.isError;

  return (
    <>
      <section className="flex flex-col gap-2.5 px-5 pt-3">
        <BalanceHero
          label="Total balance"
          info={{ label: "What’s in your total balance", onClick: () => open("total") }}
          value={data.stocksUsd + data.cashUsd}
          // All time once P&L can be added up (Adrian, 2026-10-19); until then, or if it can't be read, today's change.
          // Board 2f: today's change is always there; with no stocks nothing moves, so it reads $0.00 · 0.00% today.
          sub={
            allTime ? (
              <AllTimeChange usd={allTime.gainUsd} pct={allTime.pct} />
            ) : pnlReading ? (
              <TodayPending />
            ) : today ? (
              <TodayChange usd={today.usd} pct={today.pct} />
            ) : market.loading ? (
              <TodayPending />
            ) : held.length === 0 ? (
              <TodayChange usd={0} pct={0} />
            ) : undefined
          }
          // Board 2f: what you have on the left, what you owe on the right. Owed is rounded up, never shown as less.
          side={{
            label: "Credit",
            // Credit's ⓘ explains the status (ruling 32, Adrian 2026-10-18); the owed amount opens the Credit sheet,
            // which is Repay's (with nothing owed it says only that).
            info: { label: "What your credit status means", onClick: () => open("status") },
            onClick: { label: "Open your credit", run: () => money.repay() },
            // The "$" and the cents drawn as the total balance draws them (Adrian): smaller, in the mid ink. Rounded up
            // to the cent, never shown as less than is owed.
            value: <OwedFigure usd={data.debtUsd} />,
            unit: "owed",
            // Board 2f: the status and what the credit costs a month, always (Safe and $0 / month with none taken).
            sub: (
              <span className="inline-flex items-center gap-1.5">
                {/* Ruling 1: with nothing owed it says so, not "Safe". */}
                <StatusPill status={shownStatus} size="sm" />
                <span className="whitespace-nowrap">
                  {monthlyCostText(data.monthlyCostUsd).replace(" / month", "")} /
                  <span className="text-[11px]">month</span>
                </span>
              </span>
            ),
          }}
        />
        <HeroLine
          pnl={allTime?.series}
          pnlReading={pnlReading}
          held={held.length > 0}
          stockWeek={weekValue(priced)}
          cashUsd={data.cashUsd}
          loading={market.loading}
          onRetry={market.retry}
        />
      </section>

      <section className="grid grid-cols-4 gap-2 px-5 pt-[22px]">
        <QuickAction onClick={money.topUp} label="Top up" icon={<PlusIcon />} />
        <QuickAction onClick={openTrade} label="Trade" icon={<TradeIcon />} />
        <QuickAction onClick={openCreditBuy} label="Credit Buy" icon={<CreditIcon />} />
        {/* Rulings 3 and 38: nothing owed, Repay fades and a tap says why. */}
        <QuickAction
          onClick={data.debtRaw > 0n ? () => money.repay() : () => toast("Nothing owed")}
          dim={data.debtRaw === 0n}
          label="Repay"
          icon={<RepayIcon />}
        />
      </section>

      <section className="flex flex-col gap-2.5 px-5 pt-[18px] empty:hidden">{cards}</section>

      <section className="grid grid-cols-2 gap-2.5 px-5 pt-[18px]">
        {/* Cash is what earns, without the fuel tank, which shows on its own line under it (Adrian, 2026-10-21). */}
        <CashCard
          cashUsd={cashWithoutTankUsd(data)}
          line={`Fuel tank: ${formatUsd(tankLevelUsd(data.cash.walletRaw))}`}
          dim={dim}
          note={arrived.kind === "arriving" ? `${arrived.text} arriving` : undefined}
          onClick={() => open("cash")}
        />
        <YieldCard
          apy={apy}
          value={
            earned ? (
              <LiveEarning
                earnedUsd={earned.usd}
                savingsUsd={data.savingsUsd}
                apr={data.savingsApr}
                readAt={earned.readAt}
              />
            ) : (
              <span className="num text-[26px]">–</span>
            )
          }
          // Counts only while the cash really earns: savings on Base, carried at the live rate between reads.
          line={data.savingsUsd > 0 || (earned?.usd ?? 0) > 0 ? "Earned all time" : "Not earning yet"}
          dim={dim}
          onClick={() => open("yield")}
        />
      </section>

      {/* With no stocks, the empty state takes the room down to the tab bar. */}
      <section className={`flex flex-col gap-2.5 px-5 pt-[17px] leading-[normal] ${held.length === 0 ? "grow" : ""}`}>
        <div className="flex h-[22px] items-center justify-between">
          <Link href="/portfolio" className="flex items-baseline gap-2 no-underline">
            <span className="text-lg font-semibold tracking-[-0.015em]">Portfolio</span>
            <span className="num text-sm text-subtle">{formatUsdTrim(Math.round(data.stocksUsd))}</span>
          </Link>
          <Link
            href="/portfolio"
            className="-my-[5px] -mr-1 flex h-8 items-center gap-0.5 px-1 text-[13px] font-medium text-ink-mid no-underline"
          >
            See all <ChevronRight />
          </Link>
        </div>
        {held.length === 0 ? (
          <EmptyPortfolio />
        ) : (
          <div
            className={`relative -mx-5 flex ${held.length < 2 ? "justify-start" : "justify-between"} gap-2 overflow-x-auto px-5 pb-4 pt-0.5 [scrollbar-width:none]`}
          >
            {held.map((h) => {
              const valueUsd = h.freeUsd + h.backingUsd;
              const m = market.bySymbol[h.symbol];
              return (
                <HoldingCard
                  key={h.symbol}
                  symbol={h.symbol}
                  name={h.name}
                  valueUsd={valueUsd}
                  backs={valueUsd > 0 ? h.backingUsd / valueUsd : 0}
                  today={m?.change}
                  spark={m?.day}
                  pending={market.loading}
                  shares={h.freeShares + h.backingShares}
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
      <div className="grid grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="mx-auto size-12 animate-pulse rounded-3xl bg-chip" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="h-[108px] animate-pulse rounded-[22px] bg-chip" />
        <div className="h-[108px] animate-pulse rounded-[22px] bg-chip" />
      </div>
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
    <div className="mb-4 flex grow flex-col items-center justify-center gap-3 rounded-[22px] border-[1.5px] border-dashed border-ink/20 px-5 py-5 text-center">
      {/* Compact so it fits above the tab bar (Adrian); the logos name the stocks, so no list under them. */}
      <div aria-hidden className="flex gap-1">
        {EQUITIES.map((e) => (
          <StockAvatar key={e.symbol} symbol={e.symbol} size={32} />
        ))}
      </div>
      <p className="m-0 text-[15px] font-semibold tracking-[-0.01em]">You don’t hold any stocks yet</p>
      <span className="sr-only">{EQUITIES.map((e) => e.name).join(", ")}</span>
      {/* Ruling 5: the first step, as a text link (Top up and Trade sit above it). */}
      <Link href="/buy" className="text-[14px] font-semibold text-ink underline underline-offset-2">
        Buy your first stock
      </Link>
    </div>
  );
}

/** What's owed in the hero: "$8.04", the "$" and the cents smaller and in the mid ink, as the total balance draws them. */
function OwedFigure({ usd }: { usd: number }) {
  const [int, cents] = ceilCents(usd).toFixed(2).split(".");
  return (
    <>
      <span className="text-[22px] font-medium tracking-normal text-ink-mid">$</span>
      {Number(int).toLocaleString("en-US")}
      <span className="text-[19px] font-medium tracking-normal text-ink-mid">.{cents}</span>
    </>
  );
}

/**
 * The leverage tag (canvas board 12): what you hold ÷ your own money, next to the menu while something is owed. A tap
 * opens "Your leverage".
 */
function LeverageTag({ data, onOpen }: { data: PositionData; onOpen: () => void }) {
  const x = leverageOf({ holdUsd: data.stocksUsd + data.cashUsd, owedUsd: data.debtUsd });
  if (!x) return null;
  const text = leverageText(x);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`My leverage: ${text}. What it means`}
      // The tap area stays 40px tall; the chip it holds is small and light, in proportion with the header.
      className="flex h-10 items-center"
    >
      <span className="num flex h-6 items-center gap-1.5 rounded-xl border border-line-field bg-card pl-2 pr-2.5 text-[12px] font-semibold tracking-[-0.01em] text-ink-2">
        <span aria-hidden className="size-1.5 rounded-full bg-brand ring-1 ring-ink/25" />
        {text}
      </span>
    </button>
  );
}

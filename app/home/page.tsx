"use client";

import Link from "next/link";
import { useState } from "react";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Header } from "@/components/gg/Header";
import { TabBar } from "@/components/gg/TabBar";
import { BalanceHero } from "@/components/gg/BalanceHero";
import { QuickAction } from "@/components/gg/QuickAction";
import { CashCard, CreditCard } from "@/components/gg/Cards";
import { AddStockCard, HoldingCard } from "@/components/gg/Holding";
import { CreditSheet } from "@/components/gg/CreditSheet";
import { TotalBalanceSheet, YieldSheet } from "@/components/gg/InfoSheets";
import { Button } from "@/components/gg/Button";
import { ChevronRight, CreditIcon, PlusIcon, RepayIcon, TradeIcon } from "@/components/gg/icons";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { homeStatus } from "@/lib/risk/status";
import { formatUsd, formatUsdTrim } from "@/lib/formatting";

export default function HomePage() {
  return <RequireAccount>{(address) => <Home address={address} />}</RequireAccount>;
}

type Sheet = "total" | "yield" | "credit";

/**
 * Design board "2 · Home · portfolio: Rail" (HomeUpliftRail.dc.html), with its sheets: Total balance (HomeInfo),
 * Average yield (HomeYieldInfo) and Credit (HomeCreditSlide). Today's change, the all-time return, the return
 * line and each holding's day stay hidden until price history and the PnL engine exist (plan items 7 and 8).
 */
function Home({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const close = () => setSheet(null);
  const apy = data ? aprToApy(data.savingsApr) : 0;

  return (
    <div className="relative min-h-dvh">
      <Header address={address} />

      {isError && !data && (
        <div className="mx-5 mt-4 rounded-[22px] bg-card p-4 shadow-card-elev">
          <p role="alert" className="m-0 text-[15px]">We couldn’t load your account from Base.</p>
          <button type="button" onClick={() => refetch()} className="mt-3 h-11 rounded-full bg-chip px-4 font-semibold">
            Try again
          </button>
        </div>
      )}

      {!data ? <Skeleton /> : <Loaded data={data} apy={apy} open={setSheet} />}

      <TabBar />
      {data && (
        <>
          <TotalBalanceSheet open={sheet === "total"} onClose={close} cashUsd={data.cashUsd} stocksUsd={data.stocksUsd} debtUsd={data.debtUsd} />
          <YieldSheet open={sheet === "yield"} onClose={close} cashUsd={data.cashUsd} savingsUsd={data.savingsUsd} apy={apy} />
          <CreditSheet open={sheet === "credit"} onClose={close} account={address} data={data} />
        </>
      )}
    </div>
  );
}

function Loaded({ data, apy, open }: { data: PositionData; apy: number; open: (sheet: Sheet) => void }) {
  const held = data.holdings.filter((h) => h.freeShares + h.lockedShares > 0);

  return (
    <>
      <section className="flex flex-col gap-2.5 px-5 pt-[18px]">
        <BalanceHero
          label="Total balance"
          info={{ label: "What’s in your total balance", onClick: () => open("total") }}
          value={data.stocksUsd + data.cashUsd}
          side={{
            // D19: stocks earn no yield, so the average yield is the cash rate.
            label: "Average yield",
            info: { label: "How your average yield is worked out", onClick: () => open("yield") },
            value: `${(apy * 100).toFixed(1)}%`,
            unit: "APY",
          }}
        />
        <MarketBanner />
      </section>

      <section className="grid grid-cols-4 gap-2 px-5 pt-3.5">
        <QuickAction href="/buy" label="Trade" icon={<TradeIcon />} />
        <QuickAction href="/receive" label="Top up" icon={<PlusIcon />} />
        <QuickAction onClick={() => open("credit")} label="Credit Buy" icon={<CreditIcon />} />
        <QuickAction href="/repay" label="Repay" icon={<RepayIcon />} />
      </section>

      <section className="grid grid-cols-2 gap-2.5 px-5 pt-[18px]">
        <CashCard cashUsd={data.cashUsd} apy={apy} href="/receive" />
        <CreditCard
          debtUsd={data.debtUsd}
          status={homeStatus(data.status)}
          monthlyCostUsd={data.monthlyCostUsd}
          availableUsd={data.availableUsd}
          onClick={() => open("credit")}
        />
      </section>

      <section className="flex flex-col gap-2.5 px-5 pt-[17px] leading-[normal]">
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
          <div className="mb-4 flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-card-elev">
            <p className="m-0 text-[15px]">You don’t hold any supported stocks yet.</p>
            <Button variant="soft" href="/buy">
              {data.cashUsd >= 1 ? `Buy stocks with your ${formatUsd(data.cashUsd)}` : "Buy stocks"}
            </Button>
          </div>
        ) : (
          <div className={`-mx-5 flex ${held.length < 2 ? "justify-start" : "justify-between"} gap-2 overflow-x-auto px-5 pb-4 pt-0.5 [scrollbar-width:none]`}>
            {held.map((h) => {
              const valueUsd = h.freeUsd + h.lockedUsd;
              return (
                <HoldingCard
                  key={h.symbol}
                  symbol={h.symbol}
                  name={h.name}
                  valueUsd={valueUsd}
                  backs={valueUsd > 0 ? h.lockedUsd / valueUsd : 0}
                  shares={h.freeShares + h.lockedShares}
                  href="/portfolio"
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

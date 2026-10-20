"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FeedCard, FeedDays } from "@/components/gg/activity/Activity";
import { AmountArrow, AmountBadge, AmountField, AmountSource, YouGet } from "@/components/gg/kit/AmountField";
import { BalanceHero, TodayChange } from "@/components/gg/home/BalanceHero";
import { Button } from "@/components/gg/kit/Button";
import { GooseLoader } from "@/components/gg/kit/GooseLoader";
import { CashCard, CreditCard } from "@/components/gg/home/Cards";
import { AddStockCard, HoldingCard, HoldingList, HoldingRow } from "@/components/gg/stock/Holding";
import { ProtectDemo } from "./ProtectDemos";
import { MarketList, MarketRow } from "@/components/gg/stock/Market";
import { QuickAction } from "@/components/gg/home/QuickAction";
import { TabHeader } from "@/components/gg/Screen";
import { Sparkline } from "@/components/gg/home/Sparkline";
import { StatusChange, StatusPill } from "@/components/gg/Status";
import { StockAvatar } from "@/components/gg/kit/StockAvatar";
import { Summary } from "@/components/gg/home/Summary";
import { Switch } from "@/components/gg/kit/Switch";
import { TxButton } from "@/components/gg/TxUi";
import { ValueLine } from "@/components/gg/ValueLine";
import { CreditIcon, PlusIcon, RepayIcon, TradeIcon } from "@/components/gg/kit/icons";
import { useNowSec } from "@/hooks/useNowSec";
import { RebalanceDemo } from "./RebalanceDemo";
import { homeStatus } from "@/lib/risk/status";
import { boughtLine } from "@/lib/activity/bought";
import { formatUsd, formatUsdTrim } from "@/lib/formatting";
import {
  BuyDemoSheet,
  CASH,
  CASH_APY,
  HOLDINGS,
  LINE_HOME,
  LINE_INVEST,
  MARKET,
  MOVES,
  PILL_SIZES,
  STATUSES,
  Section,
  noop,
} from "./GallerySections";

export function Gallery() {
  const [amount, setAmount] = useState("20");
  const [credit, setCredit] = useState("300");
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(true);
  const now = useNowSec() * 1000;
  return (
    <div className="flex min-h-dvh flex-col gap-6 px-5 pb-12 pt-[calc(env(safe-area-inset-top)+8px)]">
      <div className="flex flex-col gap-1">
        <span className="label">Dev only</span>
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">UI kit</h1>
        <p className="m-0 text-[13px] leading-snug text-ink-mid">
          The boards’ shared pieces, with the boards’ sample figures.
        </p>
      </div>

      <Section title="Page header" kit="page-header">
        <TabHeader title="Investments" back="/home" status="safe" statusHref="/repay" />
      </Section>

      <Section title="Balance hero · Home" kit="hero-home">
        <div className="flex flex-col gap-2.5">
          <BalanceHero
            label="Total balance"
            info={{ label: "What’s in your total balance", onClick: noop }}
            value={5000}
            sub={<TodayChange usd={38.2} pct={0.0076} />}
            side={{
              label: "Average yield",
              info: { label: "How your average yield is worked out", onClick: noop },
              value: `${(CASH_APY * 100).toFixed(1)}%`,
              unit: "APY",
              sub: (
                <>
                  <span className="font-semibold text-pos">+$485</span> all-time return
                </>
              ),
            }}
          />
          <Sparkline points={LINE_HOME} variant="hero" height={68} label="Return over time" />
        </div>
      </Section>

      <Section title="Balance hero · Invest" kit="hero-invest">
        <div className="flex flex-col gap-2.5">
          <BalanceHero
            label="Portfolio"
            value={4600}
            sub={<TodayChange usd={31.4} pct={0.0069} />}
            side={{
              label: "Cash available",
              value: formatUsdTrim(CASH),
              sub: (
                <>
                  <span className="font-semibold text-pos">{(CASH_APY * 100).toFixed(1)}%</span> APY
                </>
              ),
            }}
          />
          <Sparkline points={LINE_INVEST} variant="hero" height={34} label="Portfolio value over time" />
        </div>
      </Section>

      <Section title="Value line · ready, loading, unavailable" kit="value-line">
        <div className="flex flex-col gap-4">
          <ValueLine points={LINE_INVEST} height={34} loading={false} onRetry={noop} />
          <ValueLine points={null} height={34} loading onRetry={noop} />
          <ValueLine points={null} height={34} loading={false} onRetry={noop} />
        </div>
      </Section>

      <Section title="Quick actions" kit="quick-actions">
        <div className="grid grid-cols-4 gap-2">
          <QuickAction label="Trade" icon={<TradeIcon />} onClick={noop} />
          <QuickAction label="Top up" icon={<PlusIcon />} onClick={noop} />
          <QuickAction label="Credit Buy" icon={<CreditIcon />} onClick={noop} />
          <QuickAction label="Repay" icon={<RepayIcon />} onClick={noop} />
        </div>
      </Section>

      <Section title="Cash and Credit cards" kit="cards">
        <div className="grid grid-cols-2 gap-2.5">
          <CashCard cashUsd={CASH} line="Fuel tank: $0.50" note="2 in Quarantine" onClick={noop} />
          <CreditCard debtUsd={600} status="safe" monthlyCostUsd={3} availableUsd={1100} onClick={noop} />
        </div>
      </Section>

      <Section title="Credit card · nothing owed (F2-1)" kit="credit-card-none">
        <div className="grid grid-cols-2 gap-2.5">
          <CashCard cashUsd={40} line="Fuel tank: $0.50" onClick={noop} />
          <CreditCard debtUsd={0} status={homeStatus("none")} monthlyCostUsd={0} availableUsd={1700} onClick={noop} />
        </div>
      </Section>

      <Section title="Holding cards · Home rail" kit="holding-cards">
        <div className="flex justify-between gap-2 pb-4 pt-0.5">
          {HOLDINGS.map(({ symbol, name, valueUsd, backs, today, card }) => (
            <HoldingCard
              key={symbol}
              symbol={symbol}
              name={name}
              valueUsd={valueUsd}
              backs={backs}
              today={today}
              spark={card}
              onClick={noop}
            />
          ))}
        </div>
      </Section>

      <Section title="Holding cards · market prices loading" kit="holding-cards-pending">
        <div className="flex justify-between gap-2 pb-4 pt-0.5">
          {HOLDINGS.map(({ symbol, name, valueUsd, backs, shares }) => (
            <HoldingCard
              key={symbol}
              symbol={symbol}
              name={name}
              valueUsd={valueUsd}
              backs={backs}
              shares={shares}
              pending
              onClick={noop}
            />
          ))}
        </div>
      </Section>

      <Section title="Holding cards · before price history" kit="holding-cards-shares">
        <div className="flex justify-between gap-2 pb-4 pt-0.5">
          {HOLDINGS.map(({ symbol, name, valueUsd, backs, shares }) => (
            <HoldingCard
              key={symbol}
              symbol={symbol}
              name={name}
              valueUsd={valueUsd}
              backs={backs}
              shares={shares}
              onClick={noop}
            />
          ))}
        </div>
      </Section>

      <Section title="Holding cards · two held, Add a stock (F2-1)" kit="holding-cards-add">
        <div className="flex justify-between gap-2 pb-4 pt-0.5">
          {[HOLDINGS[0], HOLDINGS[2]].map(({ symbol, name, valueUsd, shares }) => (
            <HoldingCard
              key={symbol}
              symbol={symbol}
              name={name}
              valueUsd={valueUsd}
              backs={0}
              shares={shares}
              onClick={noop}
            />
          ))}
          <AddStockCard href="#" />
        </div>
      </Section>

      <Section title="Holding rows · Invest" kit="holding-rows">
        <HoldingList title="Your holdings">
          {HOLDINGS.map(({ symbol, name, valueUsd, shares, backs, today, row }) => (
            <HoldingRow
              key={symbol}
              symbol={symbol}
              name={name}
              valueUsd={valueUsd}
              shares={shares}
              backs={backs}
              today={today}
              spark={row}
              onClick={noop}
            />
          ))}
        </HoldingList>
      </Section>

      <Section title="Market rows" kit="market-rows">
        <MarketList>
          {MARKET.map((m) => (
            <MarketRow
              key={m.symbol}
              symbol={m.symbol}
              name={m.name}
              priceUsd={m.price}
              ownedUsd={m.owned}
              onClick={noop}
            />
          ))}
        </MarketList>
      </Section>

      <Section title="Status pills" kit="status-pills">
        <div className="flex flex-col gap-2.5 rounded-[22px] bg-card p-4 shadow-card-elev">
          {PILL_SIZES.map((size) => (
            <div key={size} className="flex items-center gap-2">
              <span className="w-14 font-mono text-[11px] text-subtle">{size}</span>
              {STATUSES.map((s) => (
                <StatusPill key={s} status={s} size={size} />
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Buttons" kit="buttons">
        <div className="flex flex-col gap-2.5">
          <TxButton label="Repay" phase="idle" onClick={noop} />
          <TxButton label="Start earning" phase="idle" size="md" steps={2} onClick={noop} />
          <Button variant="dark" onClick={noop}>
            Continue
          </Button>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="white" icon={<TradeIcon size={18} strokeWidth={1.8} />} onClick={noop}>
              Market
            </Button>
            <Button icon={<CreditIcon size={18} strokeWidth={1.8} />} onClick={noop}>
              Credit Buy
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="soft" onClick={noop}>
              Buy more
            </Button>
            <Button onClick={noop}>Repay</Button>
          </div>
          <Button variant="dark" disabled>
            That’s more than your cash ($400.00)
          </Button>
        </div>
      </Section>

      <Section title="Switch" kit="switch">
        <div className="flex items-center justify-between rounded-[22px] bg-card px-4 py-3 shadow-card-elev">
          <span className="text-[15px] font-semibold">Use credit for buying</span>
          <span className="flex gap-2.5">
            <Switch checked={on} onChange={setOn} label="On" />
            <Switch checked={!on} onChange={(next) => setOn(!next)} label="Off" />
          </span>
        </div>
      </Section>

      <Section title="Amount field" kit="amount-cash">
        <AmountField
          label="You pay"
          source={<AmountSource>Cash</AmountSource>}
          badge={<AmountBadge kind="cash" />}
          value={amount}
          onValue={setAmount}
          onMax={() => setAmount(CASH.toFixed(2))}
          hint={`Cash available: ${formatUsd(CASH)}`}
        />
      </Section>

      <Section title="Amount field · on credit" kit="amount-credit">
        <AmountField
          label="On credit"
          source={<AmountSource mark={<StockAvatar symbol="NVDA" size={16} />}>Against NVIDIA</AmountSource>}
          badge={<AmountBadge kind="credit" />}
          value={credit}
          onValue={setCredit}
          onMax={() => setCredit("1000")}
          hint="Up to $1,000 against your NVIDIA"
        />
      </Section>

      <Section title="You get" kit="you-get">
        <div className="flex flex-col pt-2.5">
          <AmountArrow />
          <YouGet symbol="AAPL" shares={1.35} priceUsd={222.22} />
        </div>
      </Section>

      <Section title="Summary rows" kit="summary">
        <div className="flex flex-col gap-3">
          <Summary rows={[{ label: "Arrives", value: "In seconds" }]} />
          <Summary
            rows={[
              { label: "From your cash", value: "$400.00" },
              { label: "On credit", value: "$300.00" },
              { label: "Status", value: <StatusChange from="safe" to="safe" /> },
            ]}
          />
        </div>
      </Section>

      <Section title="Activity feed · Agents" kit="feed">
        <FeedCard>
          <FeedDays rows={MOVES(now)} nowMs={now} />
        </FeedCard>
      </Section>

      <Section title="Goose loader · walk, sleep" kit="goose-loader">
        <div className="flex flex-col items-center gap-6 rounded-[22px] bg-sheet py-6">
          <GooseLoader mode="walk" className="h-[72px] w-[210px]" />
          <GooseLoader mode="sleep" className="h-[72px] w-[210px]" />
        </div>
      </Section>

      <Section title="Sheet with steps" kit="sheet">
        <Button variant="dark" onClick={() => setOpen(true)}>
          Open the sheet
        </Button>
      </Section>

      <Section title="Toast" kit="toast">
        <div className="grid grid-cols-3 gap-2.5">
          <Button variant="white" onClick={() => toast.success(boughtLine(0.112, "NVDAc"))}>
            Bought
          </Button>
          <Button variant="white" onClick={() => toast.success(boughtLine(1.35, "AAPLc", true))}>
            On credit
          </Button>
          <Button variant="white" onClick={() => toast("Address copied")}>
            Plain
          </Button>
        </div>
      </Section>

      <Section title="Protect settings · not live yet" kit="protect-not-live">
        <ProtectDemo state="not-live" />
      </Section>

      <Section title="Protect settings · off, saving switches it on" kit="protect-off">
        <ProtectDemo state="off" />
      </Section>

      <Section title="Protect settings · on, Tesla never sold" kit="protect-on">
        <ProtectDemo state="on" />
      </Section>

      <Section title="Protect settings · selling off" kit="protect-sell-off">
        <ProtectDemo state="sell-off" />
      </Section>

      <Section title="Agent sheet · Rebalance settings" kit="rebalance-settings">
        <RebalanceDemo />
      </Section>

      <Section title="Sparklines" kit="sparklines">
        <div className="flex items-center justify-between rounded-[22px] bg-card p-4 shadow-card-elev">
          <Sparkline points={HOLDINGS[0].card} width={85} height={22} />
          <Sparkline points={HOLDINGS[1].card} width={85} height={22} />
          <Sparkline points={HOLDINGS[0].row} variant="row" width={46} height={24} />
          <Sparkline points={HOLDINGS[1].row} variant="row" width={46} height={24} />
        </div>
      </Section>

      <BuyDemoSheet open={open} onOpenChange={setOpen} />
    </div>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AmountBadge, AmountField, AmountSource } from "@/components/gg/AmountField";
import { BalanceHero, TodayChange } from "@/components/gg/BalanceHero";
import { Button } from "@/components/gg/Button";
import { CashCard, CreditCard } from "@/components/gg/Cards";
import { HoldingCard, HoldingList, HoldingRow } from "@/components/gg/Holding";
import { QuickAction } from "@/components/gg/QuickAction";
import { TabHeader } from "@/components/gg/Screen";
import { Sparkline } from "@/components/gg/Sparkline";
import { StatusChange, StatusPill, type StatusPillSize } from "@/components/gg/Status";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { NETWORK_FEE_ROW, Summary } from "@/components/gg/Summary";
import { FaceIdButton } from "@/components/gg/TxUi";
import { CreditIcon, PlusIcon, RepayIcon, TradeIcon } from "@/components/gg/icons";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import type { Status } from "@/lib/risk/status";
import { formatUsd, formatUsdTrim } from "@/lib/formatting";

// Sample figures for the gallery only, the boards' own (HomeUpliftRail, PortfolioPage, F1-4, F2-6).
// Nothing here reads the chain.
const CASH = 400;
const CASH_APY = 0.042;
// The boards' own lines, read off their SVG paths (height minus y): Home's return, Invest's value,
// then per stock the rail card's 11 points and the list row's 7.
const LINE_HOME = [12.1, 16.4, 10, 22.8, 18.5, 29.1, 24.9, 37.6, 33.4, 46.1, 44, 54.6, 61];
const LINE_INVEST = [7, 6, 10, 8, 13, 11, 16, 14, 19, 18, 23, 25, 28];
const HOLDINGS = [
  { symbol: "NVDA", name: "NVIDIA", valueUsd: 2000, shares: 11.2, backs: 0.33, today: 0.0142,
    card: [5, 4, 8, 7, 11, 9, 13, 12, 15, 14, 18], row: [2, 7, 4.5, 12, 11, 17, 22] },
  { symbol: "AAPL", name: "Apple", valueUsd: 1200, shares: 5.4, backs: 0, today: -0.0058,
    card: [15, 16, 13, 14, 11, 13, 10, 11, 8, 9, 7], row: [22, 17, 20, 11, 13, 6, 2] },
  { symbol: "TSLA", name: "Tesla", valueUsd: 1400, shares: 3.7, backs: 0.33, today: 0.021,
    card: [3, 6, 4, 9, 7, 12, 10, 15, 13, 17, 19], row: [2, 6.4, 4.7, 13.1, 10.9, 18.9, 22] },
];
const NVDA = { symbol: "NVDA", name: "NVIDIA", price: 178.57 };
const PILL_SIZES: StatusPillSize[] = ["sm", "row", "header", "md", "lg"];
const STATUSES: Status[] = ["safe", "watch", "act", "none"];

const noop = () => {};

export function Gallery() {
  const [amount, setAmount] = useState("20");
  const [credit, setCredit] = useState("300");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col gap-6 px-5 pb-12 pt-[54px]">
      <div className="flex flex-col gap-1">
        <span className="label">Dev only</span>
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">UI kit</h1>
        <p className="m-0 text-[13px] leading-snug text-ink-mid">The boards’ shared pieces, with the boards’ sample figures.</p>
      </div>

      <Section title="Page header" kit="page-header">
        <TabHeader title="Portfolio" back="/home" status="safe" statusHref="/credit" />
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
              sub: <><span className="font-semibold text-pos">+$485</span> all-time return</>,
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
              sub: <><span className="font-semibold text-pos">{(CASH_APY * 100).toFixed(1)}%</span> APY</>,
            }}
          />
          <Sparkline points={LINE_INVEST} variant="hero" height={34} label="Portfolio value over time" />
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
          <CashCard cashUsd={CASH} apy={CASH_APY} note="2 in Quarantine" onClick={noop} />
          <CreditCard debtUsd={600} status="safe" monthlyCostUsd={3} onClick={noop} />
        </div>
      </Section>

      <Section title="Holding cards · Home rail" kit="holding-cards">
        <div className="flex justify-between gap-2 pb-4 pt-0.5">
          {HOLDINGS.map(({ symbol, name, valueUsd, backs, today, card }) => (
            <HoldingCard key={symbol} symbol={symbol} name={name} valueUsd={valueUsd} backs={backs} today={today} spark={card} onClick={noop} />
          ))}
        </div>
      </Section>

      <Section title="Holding cards · before price history" kit="holding-cards-shares">
        <div className="flex justify-between gap-2 pb-4 pt-0.5">
          {HOLDINGS.map(({ symbol, name, valueUsd, backs, shares }) => (
            <HoldingCard key={symbol} symbol={symbol} name={name} valueUsd={valueUsd} backs={backs} shares={shares} onClick={noop} />
          ))}
        </div>
      </Section>

      <Section title="Holding rows · Invest" kit="holding-rows">
        <HoldingList title="Your holdings">
          {HOLDINGS.map(({ symbol, name, valueUsd, shares, backs, today, row }) => (
            <HoldingRow key={symbol} symbol={symbol} name={name} valueUsd={valueUsd} shares={shares} backs={backs} today={today} spark={row} onClick={noop} />
          ))}
        </HoldingList>
      </Section>

      <Section title="Status pills" kit="status-pills">
        <div className="flex flex-col gap-2.5 rounded-[22px] bg-card p-4 shadow-card-elev">
          {PILL_SIZES.map((size) => (
            <div key={size} className="flex items-center gap-2">
              <span className="w-14 font-mono text-[11px] text-subtle">{size}</span>
              {STATUSES.map((s) => <StatusPill key={s} status={s} size={size} />)}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Buttons" kit="buttons">
        <div className="flex flex-col gap-2.5">
          <FaceIdButton label="Repay $300 with Face ID" phase="idle" onClick={noop} />
          <div className="flex gap-2">
            <Button variant="soft" onClick={noop}>Back</Button>
            <div className="flex-1"><FaceIdButton label="Confirm with Face ID" phase="idle" size="md" onClick={noop} /></div>
          </div>
          <Button variant="dark" onClick={noop}>Review buy</Button>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="white" icon={<TradeIcon size={18} strokeWidth={1.8} />} onClick={noop}>Market</Button>
            <Button icon={<CreditIcon size={18} strokeWidth={1.8} />} onClick={noop}>Credit Buy</Button>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="soft" onClick={noop}>Buy more</Button>
            <Button onClick={noop}>Repay</Button>
          </div>
          <Button variant="dark" disabled>That’s more than your cash ($400.00)</Button>
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

      <Section title="Summary rows" kit="summary">
        <div className="flex flex-col gap-3">
          <Summary look="box" rows={[{ label: "Arrives", value: "In seconds" }, NETWORK_FEE_ROW]} />
          <Summary
            rows={[
              { label: "On credit", value: "$300.00" },
              { label: "Backed by", value: "NVIDIA" },
              { label: "Cost", value: "$1.50 / month" },
              { label: "You owe after", value: "$300.00" },
              { label: "Status", value: <StatusChange from="safe" to="safe" /> },
              NETWORK_FEE_ROW,
            ]}
          />
        </div>
      </Section>

      <Section title="Sheet with steps" kit="sheet">
        <Button variant="dark" onClick={() => setOpen(true)}>Open the sheet</Button>
      </Section>

      <Section title="Toast" kit="toast">
        <div className="grid grid-cols-2 gap-2.5">
          <Button variant="white" onClick={() => toast.success("Bought 0.1120 NVDA")}>Success</Button>
          <Button variant="white" onClick={() => toast("Address copied")}>Plain</Button>
        </div>
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

function Section({ title, kit, children }: { title: string; kit: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="label m-0 px-1">{title}</h2>
      <div data-kit={kit} className="flex flex-col">{children}</div>
    </section>
  );
}

type Step = "amount" | "review";

/** F1-4 then the F2-6 confirm layout in one drawer: back slides the other way, confirm closes and toasts. */
function BuyDemoSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [step, setStep] = useState<Step>("amount");
  const [amount, setAmount] = useState("20");
  const usd = Number(amount) || 0;
  const shares = (usd / NVDA.price).toFixed(4);

  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) setStep("amount");
  };
  const finish = () => {
    change(false);
    toast.success(`Bought ${shares} ${NVDA.symbol}`);
  };

  return (
    <SheetShell
      open={open}
      onOpenChange={change}
      title={step === "amount" ? `Buy ${NVDA.name}` : "Confirm"}
      onBack={step === "review" ? () => setStep("amount") : () => change(false)}
    >
      <SheetSteps stepKey={step} direction={step === "review" ? "forward" : "back"}>
        {step === "amount" ? (
          <div className="flex flex-col gap-3">
            <AmountField
              label="You pay"
              source={<AmountSource>Cash</AmountSource>}
              badge={<AmountBadge kind="cash" />}
              value={amount}
              onValue={setAmount}
              onMax={() => setAmount(CASH.toFixed(2))}
              hint={`Cash available: ${formatUsd(CASH)}`}
            />
            <Summary look="box" rows={[{ label: "Arrives", value: "In seconds" }, NETWORK_FEE_ROW]} />
            <Button variant="dark" disabled={usd <= 0 || usd > CASH} onClick={() => setStep("review")} className="mt-1">
              {usd <= 0 ? "Enter an amount" : usd > CASH ? `That’s more than your cash (${formatUsd(CASH)})` : "Review buy"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="pb-0.5 pt-1.5 text-center">
              <div className="num text-[25px] font-semibold tracking-[-0.03em]">{formatUsd(usd)} <span className="font-[system-ui]">→</span> {shares} {NVDA.symbol}</div>
              <div className="mt-1 text-[13px] text-ink-mid">{NVDA.name}, with your cash</div>
            </div>
            <Summary rows={[{ label: "You pay", value: formatUsd(usd) }, { label: "Price", value: formatUsd(NVDA.price) }, NETWORK_FEE_ROW]} />
            <div className="mt-1 flex gap-2">
              <Button variant="soft" onClick={() => setStep("amount")}>Back</Button>
              <div className="flex-1"><FaceIdButton label="Confirm with Face ID" phase="idle" size="md" onClick={finish} /></div>
            </div>
          </div>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

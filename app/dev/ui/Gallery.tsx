"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AmountField } from "@/components/gg/AmountField";
import { Line, WhiteCard } from "@/components/gg/Screen";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { ChevronRight } from "@/components/gg/icons";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { formatShares, formatUsd } from "@/lib/formatting";

// Sample figures for the gallery only; nothing here reads the chain.
const CASH = 1250;
const STOCKS = [
  { symbol: "AAPL", name: "Apple", price: 222.22 },
  { symbol: "NVDA", name: "NVIDIA", price: 180.5 },
];

type Stock = (typeof STOCKS)[number];
type Step = "pick" | "amount" | "review";
const STEPS: Step[] = ["pick", "amount", "review"];

export function Gallery() {
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col gap-3.5 px-5 pb-12 pt-[54px]">
      <div className="flex flex-col gap-1">
        <span className="label">Dev only</span>
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">UI base</h1>
        <p className="m-0 text-[13px] leading-snug text-ink-mid">The shared pieces the screens move onto, with sample figures.</p>
      </div>

      <Section title="Amount field">
        <AmountField
          label="You pay"
          value={amount}
          onValue={setAmount}
          onMax={() => setAmount(CASH.toFixed(2))}
          hint={`Up to ${formatUsd(CASH)} of your cash`}
        />
      </Section>

      <Section title="Sheet with steps">
        <button type="button" onClick={() => setOpen(true)} className="h-[52px] rounded-[26px] bg-ink text-[15px] font-semibold text-on-ink">
          Open the sheet
        </button>
      </Section>

      <Section title="Toast">
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => toast.success("Bought 1.3500 AAPL")} className="h-[52px] rounded-[26px] bg-card text-[15px] font-semibold shadow-card-elev">
            Success
          </button>
          <button type="button" onClick={() => toast("Address copied")} className="h-[52px] rounded-[26px] bg-card text-[15px] font-semibold shadow-card-elev">
            Plain
          </button>
        </div>
      </Section>

      <BuyDemoSheet open={open} onOpenChange={setOpen} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="label m-0 px-1">{title}</h2>
      {children}
    </section>
  );
}

/** Three steps in one drawer: back slides the other way, close ends the flow, the last step toasts. */
function BuyDemoSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [step, setStep] = useState<Step>("pick");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [stock, setStock] = useState<Stock>(STOCKS[0]);
  const [amount, setAmount] = useState("300");
  const usd = Number(amount) || 0;
  const shares = usd / stock.price;

  const go = (next: Step) => {
    setDirection(STEPS.indexOf(next) < STEPS.indexOf(step) ? "back" : "forward");
    setStep(next);
  };
  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) setStep("pick");
  };
  const finish = () => {
    change(false);
    toast.success(`Bought ${shares.toFixed(4)} ${stock.symbol}`);
  };

  return (
    <SheetShell
      open={open}
      onOpenChange={change}
      title={step === "pick" ? "Buy a stock" : step === "amount" ? `Buy ${stock.name}` : "Review buy"}
      onBack={step === "pick" ? undefined : () => go(STEPS[STEPS.indexOf(step) - 1])}
    >
      <SheetSteps stepKey={step} direction={direction}>
        {step === "pick" && (
          <WhiteCard className="px-4 py-0.5">
            {STOCKS.map((s, i) => (
              <button
                key={s.symbol}
                type="button"
                onClick={() => {
                  setStock(s);
                  go("amount");
                }}
                className={`flex w-full items-center gap-3 py-3.5 text-left ${i ? "border-t border-hairline" : ""}`}
              >
                <StockAvatar symbol={s.symbol} size={36} />
                <span className="flex-1 text-[15px] font-semibold">{s.name}</span>
                <span className="num text-[15px] font-semibold">{formatUsd(s.price)}</span>
                <ChevronRight className="text-subtle" />
              </button>
            ))}
          </WhiteCard>
        )}
        {step === "amount" && (
          <div className="flex flex-col gap-3">
            <AmountField
              label="You pay"
              value={amount}
              onValue={setAmount}
              onMax={() => setAmount(CASH.toFixed(2))}
              hint={usd > 0 ? `About ${formatShares(shares)} ${stock.symbol} at ${formatUsd(stock.price)}` : `Up to ${formatUsd(CASH)} of your cash`}
            />
            <button
              type="button"
              disabled={usd <= 0 || usd > CASH}
              onClick={() => go("review")}
              className="h-[52px] rounded-[26px] bg-ink text-[15px] font-semibold text-on-ink disabled:opacity-45"
            >
              {usd <= 0 ? "Enter an amount" : usd > CASH ? `That's more than your cash (${formatUsd(CASH)})` : "Review buy"}
            </button>
          </div>
        )}
        {step === "review" && (
          <div className="flex flex-col gap-3">
            <WhiteCard className="px-4 py-0.5">
              <Line first label="You pay" value={formatUsd(usd)} />
              <Line label="You get (estimated)" value={`${shares.toFixed(4)} ${stock.symbol}`} />
              <Line label="Price" value={formatUsd(stock.price)} />
            </WhiteCard>
            <button type="button" onClick={finish} className="h-[52px] rounded-[26px] bg-ink text-[15px] font-semibold text-on-ink">
              Close and show the toast
            </button>
          </div>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

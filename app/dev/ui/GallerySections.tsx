"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AmountBadge, AmountField, AmountSource } from "@/components/gg/AmountField";
import { Button } from "@/components/gg/Button";
import type { StatusPillSize } from "@/components/gg/Status";
import { Summary } from "@/components/gg/home/Summary";
import { TxButton } from "@/components/gg/TxUi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import type { ActivityRow } from "@/hooks/useActivity";
import type { Status } from "@/lib/risk/status";
import { formatUsd } from "@/lib/formatting";

// Sample figures for the gallery only, the boards' own (HomeUpliftRail, PortfolioPage, F1-4, F2-5, F2-6, F2-7).
// Nothing here reads the chain.
/* The dev gallery's fixtures, its section frame, and the Buy sheet demo. */

// Sample figures for the gallery only, the boards' own (HomeUpliftRail, PortfolioPage, F1-4, F2-5, F2-6, F2-7).
// Nothing here reads the chain.
export const CASH = 400;
export const CASH_APY = 0.042;
// The boards' own lines, read off their SVG paths (height minus y): Home's return, Invest's value,
// then per stock the rail card's 11 points and the list row's 7.
export const LINE_HOME = [12.1, 16.4, 10, 22.8, 18.5, 29.1, 24.9, 37.6, 33.4, 46.1, 44, 54.6, 61];
export const LINE_INVEST = [7, 6, 10, 8, 13, 11, 16, 14, 19, 18, 23, 25, 28];
export const HOLDINGS = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    valueUsd: 2000,
    shares: 11.2,
    backs: 0.33,
    today: 0.0142,
    card: [5, 4, 8, 7, 11, 9, 13, 12, 15, 14, 18],
    row: [2, 7, 4.5, 12, 11, 17, 22],
  },
  {
    symbol: "AAPL",
    name: "Apple",
    valueUsd: 1200,
    shares: 5.4,
    backs: 0,
    today: -0.0058,
    card: [15, 16, 13, 14, 11, 13, 10, 11, 8, 9, 7],
    row: [22, 17, 20, 11, 13, 6, 2],
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    valueUsd: 1400,
    shares: 3.7,
    backs: 0.33,
    today: 0.021,
    card: [3, 6, 4, 9, 7, 12, 10, 15, 13, 17, 19],
    row: [2, 6.4, 4.7, 13.1, 10.9, 18.9, 22],
  },
];
const NVDA = { symbol: "NVDA", name: "NVIDIA", price: 178.57 };
// F1-3's rows with a price: Apple and NVIDIA owned, Tesla not.
export const MARKET = [
  { symbol: "AAPL", name: "Apple", price: 222.22, owned: 1200 },
  { symbol: "NVDA", name: "NVIDIA", price: 178.57, owned: 2000 },
  { symbol: "TSLA", name: "Tesla", price: 378.38, owned: 0 },
];
const HOUR = 3_600_000;
/** Activity rows the way useActivity hands them over, timed from now so they group under Today and a weekday. */
export const MOVES = (now: number): ActivityRow[] => [
  { key: "repay", time: now - HOUR, status: "done", items: [{ kind: "repay", symbol: "USDC", amount: 180 }] },
  {
    key: "convert",
    time: now - 2 * HOUR,
    status: "pending",
    items: [{ kind: "convert", symbol: "USDT", amount: 120, receivedUsd: 119.83 }],
  },
  {
    key: "buy",
    time: now - 50 * HOUR,
    status: "done",
    items: [{ kind: "buy", symbol: "NVDAc", amount: 0.112, paidUsd: 20 }],
  },
];
export const PILL_SIZES: StatusPillSize[] = ["sm", "row", "header", "md", "lg"];
export const STATUSES: Status[] = ["safe", "watch", "act", "none"];

export const noop = () => {};

export function Section({ title, kit, children }: { title: string; kit: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="label m-0 px-1">{title}</h2>
      <div data-kit={kit} className="flex flex-col">
        {children}
      </div>
    </section>
  );
}

/** F1-4 in a drawer: the amount, what arrives and the fee, then Buy (JAW's own sheet in the app), which closes and toasts. */
export function BuyDemoSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [amount, setAmount] = useState("20");
  const usd = Number(amount) || 0;
  const shares = (usd / NVDA.price).toFixed(4);

  const finish = () => {
    onOpenChange(false);
    toast.success(`Bought ${shares} ${NVDA.symbol}`);
  };

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} title={`Buy ${NVDA.name}`} onBack={() => onOpenChange(false)}>
      <SheetSteps stepKey="amount">
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
          <Summary rows={[{ label: "Arrives", value: "In seconds" }]} />
          {usd > CASH && (
            <Button variant="dark" disabled className="mt-1">
              That’s more than your cash ({formatUsd(CASH)})
            </Button>
          )}
          <TxButton label="Buy" phase="idle" size="md" disabled={usd <= 0 || usd > CASH} onClick={finish} />
        </div>
      </SheetSteps>
    </SheetShell>
  );
}

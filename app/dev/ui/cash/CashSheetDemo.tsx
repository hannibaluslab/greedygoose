"use client";

import { ACT_LINE } from "@/config/risk";
import { toast } from "sonner";
import { CashFeed } from "@/components/gg/cash/CashActivity";
import { CashStep, cashLead } from "@/components/gg/cash/CashSheet";
import { EarnCard, EarnStep } from "@/components/gg/cash/EarnWithStocks";
import { CreditBuyCashStep } from "@/components/gg/stock/CreditBuyCashStep";
import { CreditHero, StockLists } from "@/components/gg/stock/CreditBuyStocks";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import type { Holding, PositionData } from "@/hooks/usePosition";
import type { CashFeedError } from "@/lib/cashActivity";
import { aprToApy, monthlyCost } from "@/lib/aave/math";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, type MoveContext } from "@/lib/agents/feed";
import type { AgentStatus } from "@/lib/agents/status";
import { cashRaw, toUsd, type Cash } from "@/lib/cash";
import { cashRows, type Arrival, type ExecutorMove, type OwnMove } from "@/lib/cashActivity";
import {
  backingForBuy,
  backingOptions,
  creditLine,
  creditWith,
  ownCreditUsd,
  planCredit,
  type BackingPick,
} from "@/lib/creditBuy";
import { cashRowLine, toCashQuote } from "@/lib/creditBuy/toCash";
import { earnOffer, earnTenths } from "@/lib/earnWithStocks";
import { statusFor } from "@/lib/risk/status";
import { byStockOrder, EQUITIES } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/*
 * Dev only: the Cash sheet and Earn with stocks in each state, from fixtures run through the app's own rules and words
 * (earnOffer, earnQuote, cashRows). The preview account can't show these: it has no earning, no free stock and no
 * history JAW lists. Nothing here reads the chain or signs.
 */

export const SHEET_VIEWS = [
  "sheet",
  "sheet-owed",
  "sheet-start",
  "sheet-costs-more",
  "earn",
  "earn-watch",
  "sheet-activity",
  "sheet-error",
  "credit-buy-pick",
  "credit-buy-cash",
  "credit-buy-cash-earns",
] as const;
export type SheetView = (typeof SHEET_VIEWS)[number];

const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const noop = () => toast("Dev gallery: nothing is signed");
const WAD = 10n ** 18n;
const hf = (x: number) => (BigInt(Math.round(x * 1000)) * WAD) / 1000n;

/** Live-like rates (measured 2026-10-15): cash 4.05% APR, credit 2.11% APR. */
const SAVINGS_APR = 0.0405;
const CREDIT_APR = 0.0211;
const CF = 0.7;

function holding(symbol: string, price: number, free: number, backing: number): Holding {
  const e = EQUITIES.find((x) => x.symbol === symbol)!;
  const raw = (n: number) => BigInt(Math.round(n * 1e8));
  return {
    symbol,
    name: e.name,
    reserveId: e.reserveId,
    priceUsd: price,
    priceRaw: raw(price),
    freeShares: free,
    backingShares: backing,
    freeUsd: free * price,
    backingUsd: backing * price,
    paused: false,
    frozen: false,
    freeRaw: raw(free),
    backingRaw: raw(backing),
    multiplier: WAD,
    backingEnabled: backing > 0,
    dynamicConfigKey: 0,
  };
}

/** Sam: $2,400 of cash, 3.7 Tesla free and 5 NVIDIA backing credit; `owed` on credit. */
function position(p: { owed: number; saveOn: boolean; creditApr?: number }): PositionData {
  const holdings = EQUITIES.map((e) =>
    e.symbol === "TSLAc"
      ? holding("TSLAc", 378.38, 3.7, 0)
      : e.symbol === "NVDAc"
        ? holding("NVDAc", 180, 0, 5)
        : holding(e.symbol, 100, 0, 0),
  );
  const cash: Cash = { walletRaw: usdc(1), savingsRaw: usdc(2_399), saveOn: p.saveOn };
  const totalBackingUsd = 900;
  const healthFactor = p.owed > 0 ? (totalBackingUsd * CF) / p.owed : null;
  const apr = p.creditApr ?? CREDIT_APR;
  return {
    holdings,
    stocksUsd: holdings.reduce((a, h) => a + h.freeUsd + h.backingUsd, 0),
    totalBackingUsd,
    debtUsd: p.owed,
    line: ACT_LINE,
    // As usePosition: the credit left at the one cap (Act is the line), not Aave's own limit.
    availableUsd: creditWith({
      totalBackingUsd,
      avgCf: CF,
      debtUsd: p.owed,
      healthFactor,
      usdcLiquidity: 2_770_000,
      creditPaused: false,
    }),
    healthFactor,
    avgCf: CF,
    status: statusFor(healthFactor),
    apr,
    monthlyCostUsd: monthlyCost(p.owed, apr),
    usdcBalance: toUsd(cash.walletRaw),
    usdcBalanceRaw: cash.walletRaw,
    savingsUsd: toUsd(cash.savingsRaw),
    savingsRaw: cash.savingsRaw,
    savingsApr: SAVINGS_APR,
    cash,
    cashUsd: toUsd(cashRaw(cash)),
    debtRaw: usdc(p.owed),
    usdcLiquidity: 2_770_000,
    creditPaused: false,
  };
}

const CFS = Object.fromEntries(EQUITIES.map((e) => [e.symbol, CF]));

/** A week of the cash: credit taken (confirming), money in, Protect, a conversion, a Credit Buy with cash, a send, a repay. */
function activity(nowMs: number) {
  const at = (daysBack: number, h: number, m: number) => new Date(nowMs).setHours(h, m, 0, 0) - daysBack * 86_400_000;
  const own: OwnMove[] = [
    {
      key: "earn",
      time: at(0, 11, 5),
      status: "pending",
      items: [
        { kind: "earn", symbol: "USDC", amount: 500 },
        { kind: "supply", symbol: "TSLAc", amount: 1.32 },
      ],
    },
    {
      key: "credit-buy-cash",
      time: at(1, 15, 20),
      status: "done",
      hash: tx(2),
      items: [
        { kind: "borrow", symbol: "USDC", amount: 300 },
        { kind: "buy", symbol: "NVDAc", amount: 2.21, paidUsd: 400 },
      ],
    },
    // A pure Credit Buy moves no cash, and a failed batch moves nothing: neither is a row.
    {
      key: "credit-buy",
      time: at(1, 9, 0),
      status: "done",
      hash: tx(3),
      items: [
        { kind: "borrow", symbol: "USDC", amount: 200 },
        { kind: "buy", symbol: "NVDAc", amount: 1.1, paidUsd: 200 },
      ],
    },
    { key: "failed", time: at(2, 9, 0), status: "failed", hash: tx(4), items: [] },
    {
      key: "sent",
      time: at(2, 18, 40),
      status: "done",
      hash: tx(5),
      items: [{ kind: "send", symbol: "USDC", amount: 20 }],
    },
    {
      key: "repaid",
      time: at(3, 10, 12),
      status: "done",
      hash: tx(6),
      items: [
        { kind: "repay", symbol: "USDC", amount: 60 },
        { kind: "withdraw", symbol: "NVDAc", amount: 0.4 },
      ],
    },
  ];
  const executor = (key: string, time: number, e: AgentEvent, ctx: MoveContext = {}): ExecutorMove => ({
    key,
    time,
    hash: tx(key.length + 10),
    event: e,
    ctx,
    details: describeAgentEvent(e, ctx)!.details,
  });
  const moves: ExecutorMove[] = [
    executor(
      "protect",
      at(0, 9, 30),
      { kind: "repaid", amountRaw: usdc(40), hfBefore: hf(1.02), hfAfter: hf(1.12) },
      { owedRaw: [usdc(340), usdc(300)] },
    ),
    // Earning moves nothing in the one pot (D20): no row.
    executor("save", at(0, 9, 40), { kind: "saved", amountRaw: usdc(250) }),
    executor("convert", at(1, 18, 5), {
      kind: "converted",
      coin: ENTRY_COINS[0].address,
      amountInRaw: usdc(120),
      usdcOutRaw: usdc(119.83),
    }),
  ];
  const arrivals: Arrival[] = [
    { hash: tx(9), time: at(0, 8, 50), items: [{ kind: "receive", symbol: "USDC", amount: 250 }] },
  ];
  return { own, executor: moves, arrivals };
}

/**
 * Credit Buy's Cash row over Home: the stock list with Cash between the available stocks and My holdings, and the
 * amount at $500 backed by Tesla, the credit straight into savings. "credit-buy-cash": credit costs more than the cash
 * earns (allowed, the gap in Watch's colour); "-earns": the cash earns more.
 */
function CreditBuyCashDemo({ view }: { view: SheetView }) {
  const data = position({ owed: 300, saveOn: true, creditApr: view === "credit-buy-cash" ? 0.0435 : undefined });
  const held = data.holdings.filter((h) => h.freeShares + h.backingShares > 0).sort(byStockOrder);
  const others = EQUITIES.filter((e) => !held.some((h) => h.symbol === e.symbol));
  const priceOf = (symbol: string) => data.holdings.find((h) => h.symbol === symbol)?.priceUsd ?? 0;
  const tsla = backingOptions(data.holdings, CFS).find((o) => o.stock.symbol === "TSLAc")!;
  const reachUsd = ownCreditUsd(data, tsla);
  const cashApy = aprToApy(data.savingsApr);

  if (view === "credit-buy-pick") {
    return (
      <SheetShell open onOpenChange={() => {}} title="Credit Buy" topPx={188} onBack={noop}>
        <SheetSteps stepKey="pick" className="flex flex-col gap-4 pt-1">
          <CreditHero available={{ usd: reachUsd, line: creditLine(data.cash) }} failed={false} onRetry={noop} />
          <StockLists
            held={held}
            others={others}
            priceOf={priceOf}
            withCash={false}
            othersFirst
            cash={{ line: cashRowLine(earnTenths(cashApy)), onPick: noop }}
            onPick={noop}
          />
        </SheetSteps>
      </SheetShell>
    );
  }
  const amount = 500;
  const creditRaw = usdc(amount);
  const pick: BackingPick = { option: tsla, raw: backingForBuy(tsla, amount) };
  const plan = planCredit({ position: data, backing: pick, creditRaw, cash: data.cash });
  const quote = toCashQuote({
    plan,
    debtUsd: data.debtUsd,
    cashApy,
    creditApyNow: aprToApy(data.apr),
    creditApyAfter: aprToApy(data.apr + 0.0002),
  });
  return (
    <SheetShell open onOpenChange={() => {}} title="Credit Buy Cash" onBack={noop}>
      <SheetSteps stepKey="amount" className="flex flex-col gap-3">
        <CreditBuyCashStep
          data={data}
          chosen={tsla}
          pick={pick}
          reachUsd={reachUsd}
          raw={String(amount)}
          setRaw={noop}
          ack={false}
          setAck={noop}
          amount={amount}
          plan={plan}
          quote={quote}
          blocker={null}
          ready
          protect="on"
          sell="on"
          feeBlocked={false}
          feeLoading={false}
          preview={false}
          signable
          tx={{ phase: "idle", error: null, checking: false, blocked: false, onSign: noop }}
        />
      </SheetSteps>
    </SheetShell>
  );
}

export function CashSheetDemo({ view, nowSec }: { view: SheetView; nowSec: number }) {
  if (view.startsWith("credit-buy")) return <CreditBuyCashDemo view={view} />;
  const nowMs = nowSec * 1000;
  const owed = view === "sheet" || view === "sheet-start" ? 0 : 300;
  const save: AgentStatus = view === "sheet-start" ? "off" : "on";
  const data = position({ owed, saveOn: save === "on", creditApr: view === "sheet-costs-more" ? 0.0435 : undefined });
  const offer = earnOffer({
    cashApy: aprToApy(data.savingsApr),
    creditApy: aprToApy(data.apr),
    position: data,
    options: backingOptions(data.holdings, CFS),
    cash: data.cash,
  });
  const a = activity(nowMs);
  const rows = view === "sheet" || view === "sheet-start" ? [] : cashRows({ ...a, since: nowMs - 7 * 86_400_000 });
  const error: CashFeedError = view === "sheet-error" ? "some" : null;

  if ((view === "earn" || view === "earn-watch") && offer.kind === "offer") {
    return (
      <SheetShell open onOpenChange={() => {}} look="info" title="Earn with stocks" onBack={noop}>
        <SheetSteps stepKey="earn" className="num flex flex-col gap-4 leading-[normal]">
          <EarnStep
            user="0x2b8ce2c87c166d8e24e186e7e4253c11fc805427"
            data={data}
            offer={offer}
            options={backingOptions(data.holdings, CFS)}
            protect="on"
            sell="on"
            phase="idle"
            error={null}
            preview={false}
            feeBlocked={null}
            onEarn={noop}
            initialAmount={view === "earn" ? "500" : "1000"}
            fixedApyAfter={aprToApy(CREDIT_APR + 0.0002)}
          />
        </SheetSteps>
      </SheetShell>
    );
  }
  return (
    <SheetShell
      open
      onOpenChange={() => {}}
      look="info"
      title="Cash"
      description={cashLead(save, aprToApy(data.savingsApr))}
    >
      <SheetSteps stepKey="cash" className="num flex flex-col gap-4 leading-[normal]">
        <CashStep
          data={data}
          arrived={{ kind: "none" }}
          offer={offer}
          onEarn={noop}
          // Owed, part of it earning: the card says so, with Stop earning with stocks.
          card={
            view === "sheet-owed" ? (
              <EarnCard
                offer={offer}
                onOpen={noop}
                earning={{
                  usd: 200,
                  rates: { earn: 45, cost: 19, left: 26 },
                  used: [{ symbol: "NVDA", name: "NVIDIA", shares: 1.6, usd: 296 }],
                  onStop: noop,
                }}
              />
            ) : undefined
          }
          activity={
            <CashFeed
              rows={view === "sheet-error" ? rows.slice(0, 2) : rows}
              nowMs={nowMs}
              loading={false}
              error={error}
              onRetry={noop}
            />
          }
        />
      </SheetSteps>
    </SheetShell>
  );
}

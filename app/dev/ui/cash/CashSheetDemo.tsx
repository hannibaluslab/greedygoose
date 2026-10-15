"use client";

import { toast } from "sonner";
import { CashFeed } from "@/components/gg/CashActivity";
import { CashStep, cashLead } from "@/components/gg/CashSheet";
import { EarnStep } from "@/components/gg/EarnWithStocks";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import type { Holding, PositionData } from "@/hooks/usePosition";
import type { CashFeedError } from "@/hooks/useCashActivity";
import { aprToApy, monthlyCost } from "@/lib/aave/math";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, type MoveContext } from "@/lib/agents/feed";
import { nyDay } from "@/lib/agents/next";
import type { AgentStatus } from "@/lib/agents/status";
import { cashRaw, toUsd, type Cash } from "@/lib/cash";
import { cashRows, type Arrival, type ExecutorMove, type OwnMove } from "@/lib/cashActivity";
import { backingOptions } from "@/lib/creditBuy";
import { earnOffer, type SaveRoomInput } from "@/lib/earnWithStocks";
import { statusFor } from "@/lib/risk/status";
import { EQUITIES } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/*
 * Dev only: the Cash sheet and Earn with stocks in each state, from fixtures run through the app's own rules and words
 * (earnOffer, earnQuote, cashRows). The preview account can't show these: it has no earning, no free stock and no
 * history JAW lists. Nothing here reads the chain or signs.
 */

export const SHEET_VIEWS = ["sheet", "sheet-owed", "sheet-start", "sheet-costs-more", "sheet-no-room", "earn", "earn-watch", "sheet-activity", "sheet-error"] as const;
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

function holding(symbol: string, price: number, free: number, locked: number): Holding {
  const e = EQUITIES.find((x) => x.symbol === symbol)!;
  const raw = (n: number) => BigInt(Math.round(n * 1e8));
  return {
    symbol,
    name: e.name,
    reserveId: e.reserveId,
    priceUsd: price,
    priceRaw: raw(price),
    freeShares: free,
    lockedShares: locked,
    freeUsd: free * price,
    lockedUsd: locked * price,
    paused: false,
    frozen: false,
    freeRaw: raw(free),
    lockedRaw: raw(locked),
    multiplier: WAD,
    collateralEnabled: locked > 0,
    dynamicConfigKey: 0,
  };
}

/** Sam: $2,400 of cash, 3.7 Tesla free and 5 NVIDIA backing credit; `owed` on credit. */
function position(p: { owed: number; saveOn: boolean; creditApr?: number }): PositionData {
  const holdings = EQUITIES.map((e) =>
    e.symbol === "TSLAc" ? holding("TSLAc", 378.38, 3.7, 0) : e.symbol === "NVDAc" ? holding("NVDAc", 180, 0, 5) : holding(e.symbol, 100, 0, 0),
  );
  const cash: Cash = { walletRaw: usdc(1), savingsRaw: usdc(2_399), saveOn: p.saveOn };
  const collateralUsd = 900;
  const healthFactor = p.owed > 0 ? (collateralUsd * CF) / p.owed : null;
  const apr = p.creditApr ?? CREDIT_APR;
  return {
    holdings,
    stocksUsd: holdings.reduce((a, h) => a + h.freeUsd + h.lockedUsd, 0),
    collateralUsd,
    debtUsd: p.owed,
    availableUsd: collateralUsd * CF - p.owed,
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
    borrowPaused: false,
  };
}

const CFS = Object.fromEntries(EQUITIES.map((e) => [e.symbol, CF]));

/** Save's room: $1,000 a day, none used yet; or today's six saves made. */
function room(data: PositionData, nowSec: number, full: boolean): SaveRoomInput {
  return {
    leftRaw: full ? usdc(600) : usdc(1_000),
    walletRaw: data.cash.walletRaw,
    keepBackRaw: usdc(1),
    minSaveRaw: usdc(1),
    savesDay: nyDay(nowSec),
    savesToday: full ? 6 : 1,
    maxSavesPerDay: 6,
    nowSec,
  };
}

/** A week of the cash: credit taken (confirming), money in, Protect, a conversion, a Credit Buy with cash, a send, a repay. */
function activity(nowMs: number) {
  const at = (daysBack: number, h: number, m: number) => new Date(nowMs).setHours(h, m, 0, 0) - daysBack * 86_400_000;
  const own: OwnMove[] = [
    { key: "earn", time: at(0, 11, 5), status: "pending", items: [{ kind: "supply", symbol: "TSLAc", amount: 1.32 }, { kind: "borrow", symbol: "USDC", amount: 500 }] },
    {
      key: "credit-buy-cash",
      time: at(1, 15, 20),
      status: "done",
      hash: tx(2),
      items: [{ kind: "borrow", symbol: "USDC", amount: 300 }, { kind: "buy", symbol: "NVDAc", amount: 2.21, paidUsd: 400 }],
    },
    // A pure Credit Buy moves no cash, and a failed batch moves nothing: neither is a row.
    { key: "credit-buy", time: at(1, 9, 0), status: "done", hash: tx(3), items: [{ kind: "borrow", symbol: "USDC", amount: 200 }, { kind: "buy", symbol: "NVDAc", amount: 1.1, paidUsd: 200 }] },
    { key: "failed", time: at(2, 9, 0), status: "failed", hash: tx(4), items: [] },
    { key: "sent", time: at(2, 18, 40), status: "done", hash: tx(5), items: [{ kind: "send", symbol: "USDC", amount: 20 }] },
    {
      key: "repaid",
      time: at(3, 10, 12),
      status: "done",
      hash: tx(6),
      items: [{ kind: "repay", symbol: "USDC", amount: 60 }, { kind: "withdraw", symbol: "NVDAc", amount: 0.4 }],
    },
  ];
  const executor = (key: string, time: number, e: AgentEvent, ctx: MoveContext = {}): ExecutorMove => ({
    key,
    time,
    hash: tx(key.length + 10),
    event: e,
    ctx,
    details: describeAgentEvent(e, time / 1000, ctx)!.details,
  });
  const moves: ExecutorMove[] = [
    executor("protect", at(0, 9, 30), { kind: "repaid", amountRaw: usdc(40), hfBefore: hf(1.05), hfAfter: hf(1.2), reason: "act" }, { owedRaw: [usdc(340), usdc(300)], used: { spentRaw: usdc(40), capRaw: usdc(100) } }),
    // Earning moves nothing in the one pot (D20): no row.
    executor("save", at(0, 9, 40), { kind: "saved", amountRaw: usdc(250) }),
    executor("convert", at(1, 18, 5), { kind: "converted", coin: ENTRY_COINS[0].address, amountInRaw: usdc(120), usdcOutRaw: usdc(119.83) }),
  ];
  const arrivals: Arrival[] = [{ hash: tx(9), time: at(0, 8, 50), items: [{ kind: "receive", symbol: "USDC", amount: 250 }] }];
  return { own, executor: moves, arrivals };
}

export function CashSheetDemo({ view, nowSec }: { view: SheetView; nowSec: number }) {
  const nowMs = nowSec * 1000;
  const owed = view === "sheet" || view === "sheet-start" ? 0 : 300;
  const save: AgentStatus = view === "sheet-start" ? "off" : "on";
  const data = position({ owed, saveOn: save === "on", creditApr: view === "sheet-costs-more" ? 0.0435 : undefined });
  const offer = earnOffer({
    save,
    cashApy: aprToApy(data.savingsApr),
    creditApy: aprToApy(data.apr),
    position: data,
    options: backingOptions(data.holdings, CFS),
    cash: data.cash,
    room: room(data, nowSec, view === "sheet-no-room"),
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
            capMaxRaw={usdc(1_000_000)}
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
    <SheetShell open onOpenChange={() => {}} look="info" title="Cash" description={cashLead(save, aprToApy(data.savingsApr))}>
      <SheetSteps stepKey="cash" className="num flex flex-col gap-4 leading-[normal]">
        <CashStep
          data={data}
          arrived={{ kind: "none" }}
          offer={offer}
          onEarn={noop}
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

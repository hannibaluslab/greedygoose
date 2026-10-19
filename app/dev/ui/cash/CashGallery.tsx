"use client";

import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { TopUpSheetView } from "@/components/gg/AddMoney";
import { AgentsFeed } from "@/components/gg/Agents";
import { BalanceHero, TodayChange } from "@/components/gg/BalanceHero";
import { CashCard, CreditCard } from "@/components/gg/Cards";
import { ArrivedCard, AutomaticStep, cashNowText, StartEarningCard } from "@/components/gg/CashSetup";
import { QuickAction } from "@/components/gg/QuickAction";
import { TabHeader } from "@/components/gg/Screen";
import { TabBar } from "@/components/gg/TabBar";
import { TxDone } from "@/components/gg/TxUi";
import { CreditIcon, MenuIcon, PlusIcon, RepayIcon, TradeIcon } from "@/components/gg/icons";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import type { FeedRow } from "@/components/gg/activity/Activity";
import type { ActivityRow } from "@/hooks/useActivity";
import type { GrantView } from "@/hooks/useCashSetup";
import type { ConvertQuote } from "@/lib/tx/plans";
import { useNowSec } from "@/hooks/useNowSec";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, type MoveContext } from "@/lib/agents/feed";
import { arrivedCoins, arrivedView, rateText, startEarningText } from "@/lib/cashSetup";
import { convertFloorRaw } from "@/lib/swap/entry";
import { TAP_AGAIN } from "@/lib/tx/prepared";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { CashSheetDemo, SHEET_VIEWS, type SheetView } from "./CashSheetDemo";

/*
 * Dev only: earning and other dollars becoming cash (D20), in each state, from fixtures run through the app's own
 * rules and words (arrivedView, arrivedText, describeAgentEvent). Nothing here reads the chain or signs.
 *   /dev/ui/cash?view=home        Home with "120 USDT arrived · Turn into cash" (its one screen) and "Your $100 arrived ·
 *                                 Start earning"
 *   ?view=start                   Start earning's other states: "$40 isn't earning" with the Save grant to follow
 *                                 ("2 steps"), confirming on Base, and the grant left after the batch landed
 *   ?view=arriving                Home once other dollars convert on their own: the Cash card says "arriving"
 *   ?view=convert                 "Turn into cash" with one coin under the floor: it stays as it is
 *   ?view=auto                    once it lands, "Do this automatically next time?"
 *   ?view=done                    converted, with nothing to ask (no executor, or it already converts on its own)
 *   ?view=pay | pay-setup         the Top up sheet over Home, while the cash earns and before earning is set up
 *   ?view=activity                Activity with the cash's own events
 * The Cash sheet (CashSheetDemo), over Home:
 *   ?view=sheet                   earning, nothing owed, Earn with stocks offered, no activity yet
 *   ?view=sheet-owed              $300 owed beside the cash, and the week's cash activity
 *   ?view=sheet-start             before earning is on (as on the public link): Earn with stocks still offered
 *   ?view=sheet-costs-more        credit costs more than the cash earns: the rates, and no button
 *   ?view=earn | earn-watch       the earn step at $500 (Safe), and at $1,000 (Watch, with the risk tick)
 *   ?view=sheet-activity          the activity with a row open (&open=n in the screenshots)
 *   ?view=sheet-error             part of the activity couldn't be read
 */

const RATE = rateText(0.0391);
const ADDRESS = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const [USDT, USDE] = ENTRY_COINS;
/** 120 USDT in the wallet, and nothing else: what the Entry coins' balances would read. */
const BALANCES = [usdc(120), 0n, 0n, 0n];
const QUOTES: ConvertQuote[] = [
  { coin: USDT, amountIn: usdc(120), minOut: convertFloorRaw(USDT, usdc(120)), outRaw: usdc(119.83), fair: true },
];
/** 50 USDe its venue pays under 99.5% for right now. */
const UNFAIR: ConvertQuote = {
  coin: USDE,
  amountIn: 50n * 10n ** 18n,
  minOut: convertFloorRaw(USDE, 50n * 10n ** 18n),
  outRaw: usdc(49.1),
  fair: false,
};
const GRANT: GrantView = { busy: false, error: null, blocked: null, preview: false };
const ZERO_TX = `0x${"0".repeat(64)}` as const;
const noop = () => toast("Dev gallery: nothing is signed");

type View = "home" | "start" | "arriving" | "convert" | "auto" | "done" | "pay" | "pay-setup" | "activity" | SheetView;
const VIEWS: View[] = [
  "home",
  "start",
  "arriving",
  "convert",
  "auto",
  "done",
  "pay",
  "pay-setup",
  "activity",
  ...SHEET_VIEWS,
];
const ARRIVED = startEarningText({ walletUsd: 100, savingsUsd: 0, rate: RATE });
const IDLE = startEarningText({ walletUsd: 40, savingsUsd: 1_200, rate: RATE });
const isSheetView = (v: View): v is SheetView => (SHEET_VIEWS as readonly string[]).includes(v);

export function CashGallery() {
  const raw = useSearchParams().get("view") as View | null;
  const view: View = raw && VIEWS.includes(raw) ? raw : "home";
  const nowSec = useNowSec();
  if (!nowSec) return null;

  if (view === "pay" || view === "pay-setup") {
    return (
      <HomeFixture
        cards={null}
        sheet={
          <TopUpSheetView
            open
            onClose={noop}
            address={ADDRESS}
            name="sam.justan.id"
            rate={view === "pay" ? RATE : null}
            onCopy={noop}
          />
        }
      />
    );
  }
  if (view === "activity") return <ActivityFixture nowSec={nowSec} />;
  if (view === "start") {
    return (
      <HomeFixture
        cards={
          <>
            <StartEarningCard {...IDLE} phase="idle" steps={2} error={null} preview={false} onStart={noop} />
            <StartEarningCard {...ARRIVED} phase="pending" error={null} preview={false} onStart={noop} />
            <StartEarningCard
              {...IDLE}
              phase="idle"
              steps={2}
              error={`1 of 2 went through. ${TAP_AGAIN}`}
              preview={false}
              onStart={noop}
            />
          </>
        }
        sheet={null}
      />
    );
  }
  if (isSheetView(view)) return <HomeFixture cards={null} sheet={<CashSheetDemo view={view} nowSec={nowSec} />} />;

  // Home: before other dollars convert on their own they're asked about; after, the Cash card says they're arriving.
  const arrived = arrivedView(arrivedCoins(BALANCES), view === "arriving" ? "on" : "off");
  const sheet =
    view === "auto" ? (
      <Sheet title="Do this automatically next time?">
        <AutomaticStep landed={cashNowText(QUOTES)} grant={GRANT} onYes={noop} onNo={noop} />
      </Sheet>
    ) : view === "done" ? (
      <Sheet title="Turn into cash">
        <TxDone title="It’s cash now" body="About $119.83 is in your cash." txHash={ZERO_TX} onDone={noop} />
      </Sheet>
    ) : null;
  return (
    <HomeFixture
      note={arrived.kind === "arriving" ? `${arrived.text} arriving` : undefined}
      cards={
        view !== "arriving" && (
          <>
            {/* Once a conversion lands the coins are cash, so the card is gone behind "auto" and "done". */}
            {arrived.kind === "ask" && view !== "auto" && view !== "done" && (
              <ArrivedCard
                text={view === "convert" ? "120 USDT and 50 USDe" : arrived.text}
                quotes={view === "convert" ? [...QUOTES, UNFAIR] : QUOTES}
                phase="idle"
                error={null}
                preview={false}
                onConvert={noop}
              />
            )}
            {view === "home" && (
              <StartEarningCard {...ARRIVED} phase="idle" error={null} preview={false} onStart={noop} />
            )}
          </>
        )
      }
      sheet={sheet}
    />
  );
}

function Sheet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SheetShell open onOpenChange={() => {}} title={title}>
      <SheetSteps stepKey={title} className="flex flex-col gap-3.5">
        {children}
      </SheetSteps>
    </SheetShell>
  );
}

/** Home's top half with the boards' sample figures (HomeUpliftRail): the hero, the quick actions, the cash cards. */
function HomeFixture({ note, cards, sheet }: { note?: string; cards: ReactNode; sheet: ReactNode }) {
  return (
    <div className="relative min-h-dvh">
      <header className="flex items-center justify-between px-5 pt-[calc(env(safe-area-inset-top)+8px)]">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-[18px] bg-ink text-sm font-semibold text-on-ink"
          >
            S
          </span>
          <div className="flex flex-col leading-[1.3]">
            <span className="text-[15px] font-medium">Hi, Sam</span>
            <span className="num text-xs text-subtle">sam.justan.id</span>
          </div>
        </div>
        <span className="-mr-2 flex size-10 items-center justify-center">
          <MenuIcon />
        </span>
      </header>
      <section className="flex flex-col gap-2.5 px-5 pt-[18px]">
        <BalanceHero
          label="Total balance"
          value={5000}
          sub={<TodayChange usd={38.2} pct={0.0076} />}
          side={{ label: "Average yield", value: RATE, unit: "APY" }}
        />
      </section>
      <section className="grid grid-cols-4 gap-2 px-5 pt-3.5">
        <QuickAction href="#" label="Trade" icon={<TradeIcon />} />
        <QuickAction href="#" label="Top up" icon={<PlusIcon />} />
        <QuickAction href="#" label="Credit Buy" icon={<CreditIcon />} />
        <QuickAction href="#" label="Repay" icon={<RepayIcon />} />
      </section>
      <section className="flex flex-col gap-2.5 px-5 pt-[18px] empty:hidden">{cards}</section>
      <section className="grid grid-cols-2 gap-2.5 px-5 pt-[18px]">
        <CashCard cashUsd={400} line="Fuel tank: $0.10" note={note} href="#" />
        <CreditCard debtUsd={600} status="safe" monthlyCostUsd={3} availableUsd={800} href="#" />
      </section>
      <TabBar />
      {sheet}
    </div>
  );
}

/** Activity as the app draws it: the cash's own events among the user's and Protect's moves. */
function ActivityFixture({ nowSec }: { nowSec: number }) {
  const nowMs = nowSec * 1000;
  const at = (daysBack: number, h: number, m: number) =>
    new Date(nowMs).setHours(h, m, 0, 0) / 1000 - daysBack * 86_400;
  const hf = (x: number) => (BigInt(Math.round(x * 1000)) * 10n ** 18n) / 1000n;
  const tesla = Array.from({ length: 7 }, (_, i) => (i === 6 ? BigInt(Math.round((180 / 378.38) * 1e8)) : 0n));
  const executor: [string, number, AgentEvent, MoveContext][] = [
    ["save", at(0, 9, 40), { kind: "saved", amountRaw: usdc(40) }, {}],
    [
      "sale",
      at(0, 3, 12),
      { kind: "sold", sharesRaw: tesla, repaidRaw: usdc(178.2), hfBefore: hf(1.24), hfAfter: hf(1.52), atOnce: false },
      {
        owedRaw: [usdc(780), usdc(600)],
        cashRaw: [usdc(400), usdc(401.8)],
        pricesRaw: [0n, 0n, 0n, 0n, 0n, 0n, 37_838_000_000n],
      },
    ],
    [
      "arrived",
      at(1, 18, 5),
      { kind: "converted", coin: USDT.address, amountInRaw: usdc(120), usdcOutRaw: usdc(119.83) },
      {},
    ],
    ["save-3", at(3, 11, 2), { kind: "saved", amountRaw: usdc(500) }, {}],
  ];
  const yours: ActivityRow[] = [
    {
      key: "turned",
      time: at(2, 14, 30) * 1000,
      status: "done",
      hash: ZERO_TX,
      items: [{ kind: "convert", symbol: USDE.symbol, amount: 50, receivedUsd: 49.97 }],
    },
    {
      key: "buy",
      time: at(2, 10, 20) * 1000,
      status: "done",
      hash: ZERO_TX,
      items: [{ kind: "buy", symbol: "NVDAc", amount: 0.112, paidUsd: 20 }],
    },
  ];
  const rows: FeedRow[] = [
    ...executor.map(([key, time, e, ctx]) => ({
      ...describeAgentEvent(e, time, ctx)!,
      key,
      time: time * 1000,
      hash: ZERO_TX,
      event: e,
      ctx,
    })),
    ...yours,
  ].sort((a, b) => b.time - a.time);
  return (
    <div className="relative flex min-h-dvh flex-col gap-4 px-5 pt-[calc(env(safe-area-inset-top)+8px)]">
      <TabHeader title="Activity" />
      <AgentsFeed
        title={null}
        empty=""
        rows={rows}
        nowMs={nowMs}
        loading={false}
        error={null}
        onRetry={() => {}}
        more={false}
        onShowEarlier={() => {}}
      />
      <TabBar />
    </div>
  );
}

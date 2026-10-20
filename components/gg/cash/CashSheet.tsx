"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { FinishTurningOn } from "@/components/gg/agents/FinishTurningOn";
import { Button } from "../kit/Button";
import { CashActivity } from "./CashActivity";
import { EarnCard, EarnStep } from "./EarnWithStocks";
import { useMoneySheets } from "./MoneySheets";
import { Money } from "../kit/Money";
import { useActivity } from "@/hooks/useActivity";
import { useEarnOffer, useEarnWithStocks } from "@/hooks/useEarnWithStocks";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { PositionData } from "@/hooks/usePosition";
import type { AgentStatus } from "@/lib/agents/status";
import { aprToApy } from "@/lib/aave/math";
import { cashWithoutTankUsd, tankLevelUsd } from "@/lib/fuelTank";
import { cashFromCreditUsd, owedBeside } from "@/lib/cashActivity";
import { formatUsd } from "@/lib/formatting";
import { earningLine, type ArrivedView } from "@/lib/cashSetup";
import {
  earnDone,
  earnRates,
  earnTenths,
  pctText,
  usedForEarning,
  type EarnOffer,
  type EarnOpen,
} from "@/lib/earnWithStocks";

type Step = "cash" | "earn";

/**
 * The lead under the title, by earning's state (D20: the cash is one pot that earns). The rate is the Earn with stocks
 * card's (rounded down to a tenth), so the sheet says one rate. Off says nothing more: the amount's line already does.
 */
export function cashLead(save: AgentStatus, apy: number): string {
  if (save === "on") return `Ready to spend, and earning ${pctText(earnTenths(apy))} a year while it waits.`;
  if (save === "starting") return "Ready to spend. It starts earning in a moment.";
  return "Ready to spend.";
}

/**
 * The cash, big, as the kit draws money and as Home's Cash card counts it (no fuel tank), with the Cash card's own line
 * under it; then what it's made of (`split`, CashSplit); and what's owed on credit in the same card under a hairline
 * (Adrian: one section).
 */
function CashAmount({ data, arrived, split }: { data: PositionData; arrived: ArrivedView; split?: ReactNode }) {
  const owed = owedBeside(data.debtUsd, data.cash);
  return (
    <div className="flex flex-col gap-2 rounded-[22px] bg-card p-4 shadow-card-elev">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">Cash</span>
        <span className="flex h-[22px] items-center rounded-[6px] bg-pill px-[7px] font-mono text-[10px] font-medium tracking-[0.04em] text-ink-mid">
          USDC
        </span>
      </div>
      <Money value={cashWithoutTankUsd(data)} size={38} />
      <span className="text-[13px] text-ink-mid">
        {arrived.kind === "arriving" ? `${arrived.text} arriving` : earningLine(data.cash.saveOn, data.savingsUsd)}
      </span>
      {data.cashUsd > 0 && split}
      {owed && (
        <div aria-label="Credit" className="mt-1.5 flex flex-col gap-0.5 border-t border-line-field pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[15px] text-ink-mid">You owe on credit</span>
            <span className="text-[15px] font-semibold">{owed.owed}</span>
          </div>
          <span className="text-[12.5px] text-subtle">{owed.line}</span>
        </div>
      )}
    </div>
  );
}

/** The cash that came from credit (cashFromCreditUsd, from Activity), or 0 until Activity is read. */
function useFromCredit(account: `0x${string}`, data: PositionData) {
  const history = useActivity(account);
  return history.isLoading || history.isError
    ? 0
    : cashFromCreditUsd(history.rows, data.debtUsd, cashWithoutTankUsd(data));
}

/**
 * The Earn with stocks card with what's earning from credit, mounted only while the sheet is open (it reads Activity).
 * Stop earning with stocks: this sheet slides out as Repay slides in, with that cash to repay and the stocks that back
 * credit ticked to free up.
 */
function EarnCardLive({
  account,
  data,
  offer,
  onOpen,
  onLeave,
}: {
  account: `0x${string}`;
  data: PositionData;
  offer: EarnOffer;
  onOpen: () => void;
  onLeave: () => void;
}) {
  const money = useMoneySheets();
  const usd = useFromCredit(account, data);
  const backing = data.holdings.filter((h) => h.backingShares > 0);
  const earning =
    usd >= 0.01
      ? {
          usd,
          rates: earnRates(aprToApy(data.savingsApr), aprToApy(data.apr)),
          used: usedForEarning(data.holdings, usd, data.debtUsd),
          onStop: () => {
            onLeave();
            money.stopEarning({ amountUsd: usd, free: backing.map((h) => h.symbol) });
          },
        }
      : null;
  return <EarnCard offer={offer} onOpen={onOpen} earning={earning} />;
}

/**
 * What the cash is made of: my own cash and the part that came from credit backed by stocks (Earn with stocks,
 * cashFromCreditUsd, read from Activity), which add up to the cash above; then, apart under a hairline, the fuel tank
 * kept for network fees, which the cash doesn't count (Adrian, 2026-10-21). Mounted only while the sheet is open; until
 * Activity is read (or if it can't be), no credit row, and the rest is my cash.
 */
function CashSplit({ account, data }: { account: `0x${string}`; data: PositionData }) {
  const credit = useFromCredit(account, data);
  return (
    <dl aria-label="What my cash is" className="m-0 mt-1.5 flex flex-col gap-2 border-t border-line-field pt-3">
      <SplitRow label="My cash" value={cashWithoutTankUsd(data) - credit} />
      {credit >= 0.01 && <SplitRow label="From credit" sub="Earn with stocks" value={credit} />}
      <SplitRow label="Fuel tank" sub="Kept for network fees" value={tankLevelUsd(data.cash.walletRaw)} apart />
    </dl>
  );
}

/** One part of the cash: what it is, a line under it when it needs one, and how much. `apart`: under a hairline. */
function SplitRow({
  label,
  sub,
  value,
  apart = false,
}: {
  label: string;
  sub?: string;
  value: number;
  apart?: boolean;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-3 ${apart ? "mt-0.5 border-t border-line-field pt-2.5" : ""}`}
    >
      <dt className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] text-ink-mid">{label}</span>
        {sub && <span className="text-[12px] text-subtle">{sub}</span>}
      </dt>
      <dd className="m-0 shrink-0 text-[14px] font-semibold">{formatUsd(value)}</dd>
    </div>
  );
}

/**
 * Top up, and Repay while something is owed, each a sheet that slides in as this one slides out (`onLeave` closes it).
 * Buttons name the action. Send is its own tab (2026-10-15), not offered here.
 */
function CashFooter({ owes, onLeave }: { owes: boolean; onLeave?: () => void }) {
  const money = useMoneySheets();
  const hop = (open: () => void) => () => {
    onLeave?.();
    open();
  };
  return (
    <div className={`grid gap-2.5 ${owes ? "grid-cols-2" : "grid-cols-1"}`}>
      <Button variant="soft" onClick={hop(money.topUp)}>
        Top up
      </Button>
      {owes && (
        <Button variant="soft" onClick={hop(money.repay)}>
          Repay
        </Button>
      )}
    </div>
  );
}

/** The Cash step's body, plain values in, so the dev gallery draws it with fixtures. */
export function CashStep({
  data,
  arrived,
  split,
  card,
  offer,
  onEarn,
  activity,
  onLeave,
  finish,
}: {
  data: PositionData;
  arrived: ArrivedView;
  /** What the cash is made of (CashSplit); none in the dev gallery. */
  split?: ReactNode;
  /** The Earn with stocks card, live (EarnCardLive) while the sheet is open; the plain card otherwise. */
  card?: ReactNode;
  offer: EarnOffer;
  onEarn: () => void;
  activity: ReactNode;
  onLeave?: () => void;
  /** Earning's (or converting's) grant waiting for its registration: its Finish (FinishTurningOn). */
  finish?: ReactNode;
}) {
  return (
    <>
      <CashAmount data={data} arrived={arrived} split={split} />
      {finish}
      {card ?? <EarnCard offer={offer} onOpen={onEarn} />}
      {activity}
      <CashFooter owes={data.debtUsd > 0} onLeave={onLeave} />
    </>
  );
}

/**
 * The Cash sheet, opened by Home's Cash card (Adrian, 2026-10-15): "the amount of cash, the part that is borrowed, and
 * activity what was moved or converted, received and sent/pay", with Earn with stocks. In the kit of the Total balance
 * and Average yield sheets (the info look: no Close; a tap outside or Escape closes it). One drawer, two steps: the cash,
 * and Earn with stocks, whose one button opens JAW's sheet. Its write lives here, so it survives going back a step.
 */
export function CashSheet({
  open,
  onClose,
  account,
  data,
  apy,
  arrived,
  save,
}: {
  open: boolean;
  onClose: () => void;
  account: `0x${string}`;
  data: PositionData;
  /** The cash rate as an APY. */
  apy: number;
  arrived: ArrivedView;
  /** Earning (useCashSetup's `save`). */
  save: AgentStatus;
}) {
  const [step, setStep] = useState<Step>("cash");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const earn = useEarnOffer(account, data, open);
  const tx = useEarnWithStocks();
  const fee = useFeeSupport();
  const { address: signer } = useAccount();
  const [sent, setSent] = useState(0);

  const go = (next: Step) => {
    setDirection(next === "earn" ? "forward" : "back");
    setStep(next);
  };
  const close = () => {
    onClose();
    if (!tx.busy) {
      tx.reset();
      setStep("cash");
    }
  };

  // Once the batch lands: back to the cash, where the credit shows in the activity, and a toast says so.
  const [landed, setLanded] = useState(false);
  if ((tx.phase === "done") !== landed) {
    setLanded(tx.phase === "done");
    if (tx.phase === "done") {
      setDirection("back");
      setStep("cash");
    }
  }
  const { phase, reset, txHash } = tx;
  const toasted = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "done" || toasted.current === (txHash ?? "")) return;
    toasted.current = txHash ?? "";
    toast.success(earnDone(sent));
    reset();
  }, [phase, reset, sent, txHash]);

  // The offer the batch was signed on stays while it confirms: the credit landing can close the live offer (the stocks
  // back less once it's taken) before the receipt is read, and the step mustn't drop back mid-confirmation.
  const [signedOn, setSignedOn] = useState<EarnOpen | null>(null);
  const offer: EarnOpen | null = earn.offer.kind === "offer" ? earn.offer : tx.busy ? signedOn : null;

  const preview = !signer || !isAddressEqual(signer, account);
  const feeBlocked =
    !!signer && fee.state === "unsupported" ? "Your account can’t pay network fees from your cash right now." : null;
  const earning = step === "earn" && offer !== null;

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && close()}
      look="info"
      title={earning ? "Earn with stocks" : "Cash"}
      description={earning ? undefined : cashLead(save, apy)}
      onBack={earning ? () => !tx.busy && go("cash") : undefined}
    >
      <SheetSteps
        stepKey={earning ? "earn" : "cash"}
        direction={direction}
        className="num flex flex-col gap-4 leading-[normal]"
      >
        {earning ? (
          <EarnStep
            user={account}
            data={data}
            offer={offer}
            options={earn.options}
            protect={earn.protect}
            sell={earn.sell}
            phase={tx.phase}
            error={tx.error}
            preview={preview}
            feeBlocked={feeBlocked}
            // Prepared only while the sheet is open (it stays mounted while it slides away).
            prep={open ? tx.prep : undefined}
            planFor={tx.planFor}
            onEarn={(quote, confirmedRisk, held) => {
              if (tx.phase === "failed") tx.reset();
              setSent(quote.amountUsd);
              setSignedOn(offer);
              void tx.sign(tx.planFor({ user: account, quote, offer: held, confirmedRisk }));
            }}
          />
        ) : (
          <CashStep
            data={data}
            arrived={arrived}
            split={open && <CashSplit account={account} data={data} />}
            card={
              open && (
                <EarnCardLive
                  account={account}
                  data={data}
                  offer={earn.offer}
                  onOpen={() => go("earn")}
                  onLeave={close}
                />
              )
            }
            offer={earn.offer}
            onEarn={() => go("earn")}
            activity={open && <CashActivity account={account} />}
            onLeave={close}
            finish={
              open && (
                <FinishTurningOn
                  account={account}
                  jobs={["save", "entry"]}
                  copy={(waiting) =>
                    waiting.includes("save")
                      ? {
                          title: "One more Face ID starts earning.",
                          sub: "Your cash is ready to spend. It earns once this is done.",
                        }
                      : {
                          title: "One more Face ID turns other dollars into cash.",
                          sub: "Until then, they stay as they are.",
                        }
                  }
                />
              )
            }
          />
        )}
      </SheetSteps>
    </SheetShell>
  );
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Button } from "./Button";
import { CashActivity } from "./CashActivity";
import { EarnCard, EarnStep } from "./EarnWithStocks";
import { Money } from "./Money";
import { useEarnOffer, useEarnWithStocks } from "@/hooks/useEarnWithStocks";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { PositionData } from "@/hooks/usePosition";
import type { AgentStatus } from "@/lib/agents/status";
import { owedBeside } from "@/lib/cashActivity";
import { rateText, type ArrivedView } from "@/lib/cashSetup";
import { earnDone, type EarnOffer } from "@/lib/earnWithStocks";

type Step = "cash" | "earn";

/** The lead under the title, by earning's state (D20: the cash is one pot that earns). */
export function cashLead(save: AgentStatus, apy: number): string {
  if (save === "on") return `Ready to spend, and earning ${rateText(apy)} a year while it waits.`;
  if (save === "starting") return "Ready to spend. It starts earning in a moment.";
  if (save === "off") return "Ready to spend. It isn’t earning yet.";
  return "Ready to spend.";
}

/**
 * The cash, big, as the kit draws money, with the Cash card's own line under it; and only when something is owed, what
 * is owed beside it and how it's repaid (owedBeside: the cash has no credit part on screen, since once credit lands it
 * is the same USDC as the rest; docs/JUSTALAB-DECISIONS.md, "Cash sheet").
 */
export function CashAmount({ data, arrived }: { data: PositionData; arrived: ArrivedView }) {
  const owed = owedBeside(data.debtUsd, data.cash);
  return (
    <div className="flex flex-col gap-2 rounded-[22px] bg-card p-4 shadow-card-elev">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">Cash</span>
        <span className="flex h-[22px] items-center rounded-[6px] bg-pill px-[7px] font-mono text-[10px] font-medium tracking-[0.04em] text-ink-mid">USDC</span>
      </div>
      <Money value={data.cashUsd} size={38} />
      <span className="text-[13px] text-ink-mid">
        {arrived.kind === "arriving" ? `${arrived.text} arriving` : data.cash.saveOn ? "Always earning" : "Not earning yet"}
      </span>
      {owed && (
        <div className="mt-1 flex flex-col gap-1 border-t border-hairline pt-3">
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

/** Top up, and Repay while something is owed: the routes that exist (there's no send yet). Buttons name the action. */
export function CashFooter({ owes }: { owes: boolean }) {
  return (
    <div className={`grid gap-2.5 ${owes ? "grid-cols-2" : "grid-cols-1"}`}>
      <Button variant="soft" href="/receive">Top up</Button>
      {owes && <Button variant="soft" href="/repay">Repay</Button>}
    </div>
  );
}

/** The Cash step's body, plain values in, so the dev gallery draws it with fixtures. */
export function CashStep({ data, arrived, offer, onEarn, activity }: { data: PositionData; arrived: ArrivedView; offer: EarnOffer; onEarn: () => void; activity: ReactNode }) {
  return (
    <>
      <CashAmount data={data} arrived={arrived} />
      <EarnCard offer={offer} onOpen={onEarn} />
      {activity}
      <CashFooter owes={data.debtUsd > 0} />
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
  open, onClose, account, data, apy, arrived, save,
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
  const earn = useEarnOffer(account, data, save, open);
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

  const preview = !signer || !isAddressEqual(signer, account);
  const feeBlocked = !!signer && fee.state === "unsupported" ? "Your account can’t pay network fees in USDC on Base right now." : null;
  const earning = step === "earn" && earn.offer.kind === "offer";

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && close()}
      look="info"
      title={earning ? "Earn with stocks" : "Cash"}
      description={earning ? undefined : cashLead(save, apy)}
      onBack={earning ? () => !tx.busy && go("cash") : undefined}
    >
      <SheetSteps stepKey={earning ? "earn" : "cash"} direction={direction} className="num flex flex-col gap-4 leading-[normal]">
        {earning && earn.offer.kind === "offer" ? (
          <EarnStep
            user={account}
            data={data}
            offer={earn.offer}
            options={earn.options}
            protect={earn.protect}
            sell={earn.sell}
            capMaxRaw={earn.capMaxRaw}
            phase={tx.phase}
            error={tx.error}
            preview={preview}
            feeBlocked={feeBlocked}
            onEarn={(quote, confirmedRisk) => {
              if (tx.phase === "failed") tx.reset();
              setSent(quote.amountUsd);
              void tx.earn({ user: account, quote, offer: earn.offer as Extract<EarnOffer, { kind: "offer" }>, confirmedRisk });
            }}
          />
        ) : (
          <CashStep data={data} arrived={arrived} offer={earn.offer} onEarn={() => go("earn")} activity={open && <CashActivity account={account} />} />
        )}
      </SheetSteps>
    </SheetShell>
  );
}

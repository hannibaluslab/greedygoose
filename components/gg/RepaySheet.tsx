"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Line, WhiteCard } from "./Screen";
import { StatusBar, StatusPill } from "./Status";
import { NETWORK_FEE_ROW } from "./Summary";
import { Tap } from "./Tap";
import { TxButton, TxError } from "./TxUi";
import { ChevronRight, SlidersIcon } from "./icons";
import { useTx } from "@/hooks/useTx";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { repayPlan, useRepayBatch } from "@/hooks/useRepay";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { fullRepayAmount } from "@/lib/aave/tx";
import { repayChips } from "@/lib/aave/loan";
import { cantRepay, maxSpendRaw, toUsd } from "@/lib/cash";
import { formatUsdTrim, monthlyCostText } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";

/**
 * Design board "5b · Repay" (CreditOn.dc.html) as a sheet (Adrian, 2026-10-15: "top up and repay should open a sheet not
 * a full page"), over the page it opens from: Home's Repay, the Credit and Cash sheets, Credit Buy's Repay links,
 * Protect's heads-up. It opens on the larger amount ($300), and a landed repay closes it with a toast like a buy's
 * (F1-6). Repay opens JAW's own sheet straight away: this sheet already says what you owe after and the fee, paid from
 * your cash as one pot (D20). The batch is prepared only while the sheet is open and idle, with the cash read again
 * (useSigningCash), so cash that moved since shows in words instead of a batch that can't pay, and the tap goes
 * straight to JAW. It was the /repay page, which now redirects to Home with this sheet open.
 */
export function RepaySheet({
  open, address, onClose, onTopUp, onBuyMore,
}: {
  open: boolean;
  address: `0x${string}`;
  onClose: () => void;
  /** No cash to repay with: Add money opens the Top up sheet in this one's place. */
  onTopUp: () => void;
  /** Where "Buy more with credit" goes when the Market is on the same page (Invest); the Market at /buy otherwise. */
  onBuyMore?: () => void;
}) {
  const { isConnected } = useAccount();
  const { data } = usePosition(address);
  const fee = useFeeSupport();
  const repayBatch = useRepayBatch();
  const [choice, setChoice] = useState<number | "all" | null>(null);
  const paid = useRef<string | null>(null);

  const options = useMemo(() => (data ? repayChips(Math.min(toUsd(maxSpendRaw(data.cash)), data.debtUsd)) : []), [data]);
  const feeBlocked = isConnected && fee.state === "unsupported";
  const pick = data ? repayPick(data, options, choice) : null;
  // What Repay would sign now, prepared while the sheet is open and idle (the cash read again) so the tap opens JAW's
  // sheet (useRepay: All that covers what's owed repays it as read then; otherwise exactly the amount on screen).
  const plan =
    open && pick && pick.amount > 0 && !feeBlocked
      ? repayPlan({ user: address, all: pick.all, coversAll: pick.coversAll, amount: pick.amount, amountRaw: pick.amountRaw }, repayBatch)
      : null;
  const tx = useTx(undefined, plan);

  useEffect(() => {
    if (tx.phase !== "done" || paid.current === null) return;
    toast.success(paid.current);
    paid.current = null;
    onClose();
  }, [tx.phase, onClose]);

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Repay"
      headerRight={
        <Link
          href="/agents?agent=protect"
          aria-label="Protect settings"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[rgba(15,14,11,0.06)] text-ink transition hover:bg-pill-strong"
        >
          <SlidersIcon />
        </Link>
      }
    >
      <SheetSteps stepKey="repay" className="flex flex-col gap-4">
        {!data || !pick ? (
          <div aria-busy className="h-[420px] animate-pulse rounded-[22px] bg-chip" />
        ) : (
          <RepayBody
            data={data}
            pick={pick}
            options={options}
            onChoose={setChoice}
            onTopUp={onTopUp}
            onBuyMore={
              onBuyMore
                ? () => {
                    onClose();
                    onBuyMore();
                  }
                : undefined
            }
            onLeave={onClose}
            footer={
              <>
                {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">Your account can’t pay network fees in USDC on Base right now.</p>}
                <TxError error={tx.error} />
                <TxButton
                  label="Repay"
                  size="md"
                  phase={tx.phase}
                  checking={tx.checking}
                  preview={!isConnected}
                  disabled={!plan || fee.loading || tx.blocked}
                  onClick={() => {
                    if (!plan) return;
                    if (tx.phase === "failed") tx.reset();
                    paid.current = pick.coversAll ? "Repaid all your credit" : `Repaid ${formatUsdTrim(pick.amount)}`;
                    void tx.sign();
                  }}
                />
              </>
            }
          />
        )}
      </SheetSteps>
    </SheetShell>
  );
}

type RepayPick = ReturnType<typeof repayPick>;

/** What's owed and its status, then the amount from cash, what you owe after and the fee; the button under them. */
function RepayBody({
  data, pick, options, onChoose, onTopUp, onBuyMore, onLeave, footer,
}: {
  data: PositionData;
  pick: RepayPick;
  options: number[];
  onChoose: (choice: number | "all") => void;
  onTopUp: () => void;
  /** The Market on this page (Invest), in this sheet's place. */
  onBuyMore?: () => void;
  /** Leaving for the Market at /buy: the sheet closes as the page goes. */
  onLeave: () => void;
  footer: ReactNode;
}) {
  const { maxRepay, picked, amount } = pick;
  const after = Math.max(0, data.debtUsd - amount);
  // Owed amounts are rounded up, as on Home's Credit card: never shown as less than they are.
  const owed = (usd: number) => formatUsdTrim(Math.ceil(usd));

  return (
    <>
      <WhiteCard className="flex flex-col gap-4 px-[18px] pb-1 pt-[18px] leading-[normal]">
        <div className="flex items-start justify-between gap-3">
          <div className="num flex items-baseline gap-2">
            <span className={`${data.debtUsd >= 100_000 ? "text-[38px]" : "text-5xl"} font-semibold leading-none tracking-[-0.04em]`}>{owed(data.debtUsd)}</span>
            <span className="text-base font-medium text-ink-mid">owed</span>
          </div>
          <span className="mt-1"><StatusPill status={data.status} size="lg" /></span>
        </div>
        <StatusBar status={data.status} healthFactor={data.healthFactor} />
        <div className="flex flex-col">
          <Line label="Cost" value={monthlyCostText(data.monthlyCostUsd)} />
          <Line label="Credit available" value={formatUsdTrim(data.availableUsd)} />
        </div>
      </WhiteCard>

      <WhiteCard className="flex flex-col gap-3.5 px-[18px] pb-1 pt-[18px] leading-[normal]">
        <div className="text-[17px] font-semibold">
          Repay from cash <span className="font-medium text-subtle">({formatUsdTrim(data.cashUsd)})</span>
        </div>
        {data.debtUsd === 0 ? (
          <p className="m-0 pb-4 text-[15px] text-ink-mid">You don’t owe anything.</p>
        ) : maxRepay === 0 ? (
          <p className="m-0 pb-4 text-[15px] text-ink-mid">
            {cantRepay(data.cash)}{" "}
            <button type="button" onClick={onTopUp} className="underline">Add money</button>
          </p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Amount to repay" className="grid grid-cols-3 gap-2">
              {options.map((v) => (
                <Chip key={v} selected={picked === v} onClick={() => onChoose(v)}>{formatUsdTrim(v)}</Chip>
              ))}
              <Chip selected={picked === "all"} onClick={() => onChoose("all")}>{maxRepay >= data.debtUsd ? "All" : "All cash"}</Chip>
            </div>
            <div className="flex flex-col">
              <Line label="You owe after" value={owed(after)} />
              <Line label={NETWORK_FEE_ROW.label} value={NETWORK_FEE_ROW.value} />
            </div>
          </>
        )}
      </WhiteCard>

      <Tap
        href={onBuyMore ? undefined : "/buy"}
        onClick={onBuyMore ?? onLeave}
        className="flex h-11 items-center gap-1.5 self-center px-3 text-[15px] font-semibold text-ink"
      >
        Buy more with credit <ChevronRight size={16} className="text-subtle" />
      </Tap>

      {footer}
    </>
  );
}

/**
 * The amount on screen: until a chip is tapped, the larger of the two amounts is picked, as drawn; All when it's the
 * only chip. A tapped amount that's no longer offered (the cash fell since) goes back to that too.
 */
function repayPick(data: PositionData, options: number[], choice: number | "all" | null) {
  const maxSpend = maxSpendRaw(data.cash);
  const maxRepay = Math.min(toUsd(maxSpend), data.debtUsd);
  const chosen = choice === "all" || (choice !== null && options.includes(choice)) ? choice : null;
  const picked = chosen ?? options.at(-1) ?? (maxRepay > 0 ? "all" : null);
  const amount = picked === "all" ? maxRepay : picked ?? 0;
  const amountRaw = picked === "all" ? fullRepayAmount(data.debtRaw, maxSpend) : parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
  return { maxRepay, picked, amount, amountRaw, all: picked === "all", coversAll: picked === "all" && maxSpend >= data.debtRaw };
}

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`num flex h-10 items-center justify-center rounded-[20px] text-sm ${selected ? "bg-ink font-semibold text-on-ink" : "bg-chip font-medium text-ink-2"}`}
    >
      {children}
    </button>
  );
}

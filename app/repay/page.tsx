"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import Link from "next/link";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Line, SubHeader, WhiteCard } from "@/components/gg/Screen";
import { FaceIdButton, TxDone, TxError } from "@/components/gg/TxUi";
import { useTx } from "@/hooks/useTx";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { buildRepayCalls, fullRepayAmount } from "@/lib/aave/tx";
import { USDC } from "@/lib/tokens/registry";
import { StatusBar, StatusPill } from "@/components/gg/Status";
import { ChevronRight, SlidersIcon } from "@/components/gg/icons";
import { usePosition } from "@/hooks/usePosition";
import { formatUsd } from "@/lib/formatting";

export default function RepayPage() {
  return <RequireAccount>{(address) => <Repay address={address} />}</RequireAccount>;
}

/** Design board "5b · Repay" (CreditOn.dc.html). */
function Repay({ address }: { address: `0x${string}` }) {
  const { isConnected } = useAccount();
  const { data } = usePosition(address);
  const tx = useTx();
  const fee = useFeeSupport();
  const [choice, setChoice] = useState<number | "all" | null>(null);
  const [paid, setPaid] = useState(0);

  const options = useMemo(() => {
    if (!data) return [];
    const max = Math.min(data.usdcBalance, data.debtUsd);
    const half = Math.floor(max / 2);
    const quarter = Math.floor(max / 4);
    return [quarter, half].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  }, [data]);

  if (!data) {
    return <div className="px-5 pt-[54px]"><div aria-busy className="h-[420px] animate-pulse rounded-[22px] bg-chip" /></div>;
  }

  const maxRepay = Math.min(data.usdcBalance, data.debtUsd);
  const amount = choice === "all" ? maxRepay : choice ?? 0;
  const after = Math.max(0, data.debtUsd - amount);
  const coversAll = choice === "all" && data.usdcBalanceRaw >= data.debtRaw;
  const feeBlocked = isConnected && fee.state === "unsupported";

  const submit = () => {
    if (tx.phase === "failed") tx.reset();
    const amountRaw =
      choice === "all"
        ? fullRepayAmount(data.debtRaw, data.usdcBalanceRaw)
        : parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
    setPaid(amount);
    void tx.run(address, buildRepayCalls({ user: address, amountRaw, all: choice === "all" }), undefined, [
      { kind: "repay", symbol: "USDC", amount },
    ]);
  };

  if (tx.phase === "done") {
    return (
      <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
        <SubHeader label="Credit" />
        <TxDone
          title={`You repaid ${formatUsd(paid)}`}
          body={coversAll ? "Your loan is fully repaid. You can unlock your stocks any time." : "Your loan is smaller now and costs less each month."}
          txHash={tx.txHash}
          onDone={() => {
            tx.reset();
            setChoice(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
      <SubHeader
        label="Credit"
        right={
          <Link href="/credit" aria-label="Credit details" className="flex size-9 items-center justify-center rounded-[18px] bg-chip">
            <SlidersIcon />
          </Link>
        }
      />

      <WhiteCard className="flex flex-col gap-4 px-[18px] pb-1 pt-[18px]">
        <div className="flex items-start justify-between gap-3">
          <div className="num flex items-baseline gap-2">
            <span className={`${data.debtUsd >= 1000 ? "text-[38px]" : "text-5xl"} font-semibold leading-none tracking-[-0.04em]`}>{formatUsd(data.debtUsd).replace(/\.00$/, "")}</span>
            <span className="text-base font-medium text-ink-mid">owed</span>
          </div>
          <span className="mt-1"><StatusPill status={data.status} size="lg" /></span>
        </div>
        <StatusBar status={data.status} healthFactor={data.healthFactor} />
        <div className="flex flex-col">
          <Line label="Cost" value={`${formatUsd(data.monthlyCostUsd)} / month`} />
          <Line label="Credit available" value={formatUsd(data.availableUsd)} />
        </div>
      </WhiteCard>

      <WhiteCard className="flex flex-col gap-3.5 px-[18px] pb-1 pt-[18px]">
        <div className="text-[17px] font-semibold">
          Repay from cash <span className="font-medium text-subtle">({formatUsd(data.usdcBalance)})</span>
        </div>
        {data.debtUsd === 0 ? (
          <p className="m-0 pb-4 text-[15px] text-ink-mid">You don’t owe anything.</p>
        ) : maxRepay === 0 ? (
          <p className="m-0 pb-4 text-[15px] text-ink-mid">You need USDC in your account to repay. <Link href="/receive" className="underline">Receive USDC</Link></p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Amount to repay" className="grid grid-cols-3 gap-2">
              {options.map((v) => (
                <Chip key={v} selected={choice === v} onClick={() => setChoice(v)}>{formatUsd(v).replace(/\.00$/, "")}</Chip>
              ))}
              <Chip selected={choice === "all"} onClick={() => setChoice("all")}>{maxRepay >= data.debtUsd ? "All" : "All cash"}</Chip>
            </div>
            <Line label="You owe after" value={formatUsd(after)} />
          </>
        )}
      </WhiteCard>

      <Link href="/loan" className="flex h-11 items-center gap-1.5 self-center px-3 text-[15px] font-semibold text-ink no-underline">
        Borrow more <ChevronRight size={16} className="text-subtle" />
      </Link>

      <div className="grow" />
      {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">Your account can’t pay network fees in USDC on Base right now.</p>}
      <TxError error={tx.error} />
      <FaceIdButton
        label={amount > 0 ? `Repay ${coversAll ? "all" : formatUsd(amount)} with Face ID` : "Repay with Face ID"}
        phase={tx.phase}
        preview={!isConnected}
        disabled={amount <= 0 || feeBlocked || fee.loading}
        onClick={submit}
      />
    </div>
  );
}

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
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

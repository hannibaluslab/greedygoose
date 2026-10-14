"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import Link from "next/link";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Line, SubHeader, WhiteCard } from "@/components/gg/Screen";
import { NETWORK_FEE_ROW } from "@/components/gg/Summary";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { useTx } from "@/hooks/useTx";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useSigningCash } from "@/hooks/useSigningCash";
import { buildRepayCalls, fullRepayAmount } from "@/lib/aave/tx";
import { repayChips } from "@/lib/aave/loan";
import { cantRepay, maxSpendRaw, payFromCash, savingsWithdrawal, toUsd } from "@/lib/cash";
import { USDC } from "@/lib/tokens/registry";
import { StatusBar, StatusPill } from "@/components/gg/Status";
import { ChevronRight, SlidersIcon } from "@/components/gg/icons";
import { usePosition } from "@/hooks/usePosition";
import { formatUsd, formatUsdTrim } from "@/lib/formatting";

export default function RepayPage() {
  return <RequireAccount>{(address) => <Repay address={address} />}</RequireAccount>;
}

/**
 * Design board "5b · Repay" (CreditOn.dc.html): it opens on the larger amount ($300), and a landed repay goes Home,
 * as the board's button does, with a toast like a buy's (F1-6). Repay opens JAW's own sheet straight away: this screen
 * already says what you owe after, the fee and what comes out of savings. The batch is built with the cash read again
 * right before signing (useSigningCash), so cash that moved since shows in words instead of a batch that can't pay.
 */
function Repay({ address }: { address: `0x${string}` }) {
  const { isConnected } = useAccount();
  const router = useRouter();
  const { data } = usePosition(address);
  const tx = useTx();
  const fee = useFeeSupport();
  const cashToSign = useSigningCash();
  const [choice, setChoice] = useState<number | "all" | null>(null);
  const paid = useRef<string | null>(null);

  const options = useMemo(() => (data ? repayChips(Math.min(toUsd(maxSpendRaw(data.cash)), data.debtUsd)) : []), [data]);

  useEffect(() => {
    if (tx.phase !== "done" || paid.current === null) return;
    toast.success(paid.current);
    paid.current = null;
    router.push("/home");
  }, [tx.phase, router]);

  if (!data) {
    return <div className="px-5 pt-[54px]"><div aria-busy className="h-[420px] animate-pulse rounded-[22px] bg-chip" /></div>;
  }

  const maxSpend = maxSpendRaw(data.cash);
  const maxRepay = Math.min(toUsd(maxSpend), data.debtUsd);
  // Until a chip is tapped, the larger of the two amounts is picked, as drawn; All when it's the only chip. A tapped
  // amount that's no longer offered (the cash fell since) goes back to that too.
  const chosen = choice === "all" || (choice !== null && options.includes(choice)) ? choice : null;
  const picked = chosen ?? options.at(-1) ?? (maxRepay > 0 ? "all" : null);
  const amount = picked === "all" ? maxRepay : picked ?? 0;
  const amountRaw =
    picked === "all" ? fullRepayAmount(data.debtRaw, maxSpend) : parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
  const after = Math.max(0, data.debtUsd - amount);
  // Owed amounts are rounded up, as on Home's Credit card: never shown as less than they are.
  const owed = (usd: number) => formatUsdTrim(Math.ceil(usd));
  const coversAll = picked === "all" && maxSpend >= data.debtRaw;
  const feeBlocked = isConnected && fee.state === "unsupported";
  // D7: the batch takes from savings what the wallet can't pay; the screen says so.
  const fromSavings = amountRaw > 0n ? savingsWithdrawal(amountRaw, data.cash) : null;

  const submit = () => {
    if (tx.phase === "failed") tx.reset();
    paid.current = coversAll ? "Repaid all your credit" : `Repaid ${formatUsdTrim(amount)}`;
    const all = picked === "all";
    void tx.run(
      address,
      async () => payFromCash(address, amountRaw, await cashToSign(address, amountRaw), buildRepayCalls({ user: address, amountRaw, all })),
      undefined,
      [{ kind: "repay", symbol: "USDC", amount }],
    );
  };

  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
      <SubHeader
        label="Credit"
        right={
          <Link href="/agents?agent=protect" aria-label="Protect settings" className="flex size-9 items-center justify-center rounded-[18px] bg-chip">
            <SlidersIcon />
          </Link>
        }
      />

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
          <Line label="Cost" value={`${formatUsdTrim(data.monthlyCostUsd)} / month`} />
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
          <p className="m-0 pb-4 text-[15px] text-ink-mid">{cantRepay(data.cash)} <Link href="/receive" className="underline">Add money</Link></p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Amount to repay" className="grid grid-cols-3 gap-2">
              {options.map((v) => (
                <Chip key={v} selected={picked === v} onClick={() => setChoice(v)}>{formatUsdTrim(v)}</Chip>
              ))}
              <Chip selected={picked === "all"} onClick={() => setChoice("all")}>{maxRepay >= data.debtUsd ? "All" : "All cash"}</Chip>
            </div>
            <div className="flex flex-col">
              <Line label="You owe after" value={owed(after)} />
              <Line label={NETWORK_FEE_ROW.label} value={NETWORK_FEE_ROW.value} />
            </div>
            {fromSavings && (
              <p className="m-0 -mt-1.5 pb-3.5 text-xs leading-snug text-subtle">
                {formatUsd(toUsd(fromSavings.raw))} of it comes out of savings, in the same step.
              </p>
            )}
          </>
        )}
      </WhiteCard>

      <Link href="/buy" className="flex h-11 items-center gap-1.5 self-center px-3 text-[15px] font-semibold text-ink no-underline">
        Buy more with credit <ChevronRight size={16} className="text-subtle" />
      </Link>

      <div className="grow" />
      {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">Your account can’t pay network fees in USDC on Base right now.</p>}
      <TxError error={tx.error} />
      <TxButton
        label="Repay"
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

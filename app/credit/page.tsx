"use client";

import Link from "next/link";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { Line, SubHeader, WhiteCard } from "@/components/gg/Screen";
import { StatusBar, StatusPill } from "@/components/gg/Status";
import { ChevronRight, ShieldIcon } from "@/components/gg/icons";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { usePosition } from "@/hooks/usePosition";
import { STATUS_COPY } from "@/lib/risk/status";
import { formatPct, formatUsd } from "@/lib/formatting";

export default function CreditPage() {
  return <RequireAccount>{(address) => <Credit address={address} />}</RequireAccount>;
}

/** Credit tab — layout of design board "5b · Repay" (CreditOn.dc.html), top card + details. */
function Credit({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pt-[54px]">
      <SubHeader label="Credit" />
      <MarketBanner />
      {!data ? (
        <div aria-busy className="h-[260px] animate-pulse rounded-[22px] bg-chip" />
      ) : (
        <>
          <WhiteCard className="flex flex-col gap-4 px-[18px] pb-1 pt-[18px]">
            <div className="flex items-start justify-between gap-3">
              <div className="num flex items-baseline gap-2">
                <span className={`${data.debtUsd >= 1000 ? "text-[38px]" : "text-5xl"} font-semibold leading-none tracking-[-0.04em]`}>{formatUsd(data.debtUsd).replace(/\.00$/, "")}</span>
                <span className="text-base font-medium text-muted">owed</span>
              </div>
              <span className="mt-1"><StatusPill status={data.status} size="lg" /></span>
            </div>
            <StatusBar status={data.status} healthFactor={data.healthFactor} />
            <p className="m-0 text-[13px] leading-snug text-muted">{STATUS_COPY[data.status]}</p>
            <div className="flex flex-col">
              <Line label="Cost" value={`${formatUsd(data.monthlyCostUsd)} / month`} />
              <Line label="Credit available" value={formatUsd(data.availableUsd)} />
              <Line label="Your collateral" value={formatUsd(data.collateralUsd)} />
            </div>
          </WhiteCard>

          <WhiteCard className="px-[18px] pb-1 pt-1">
            <Line first label="Borrow rate" value={`${formatPct(data.apr)} a year, variable`} />
            <Line label="Health factor" value={data.healthFactor === null ? "—" : data.healthFactor.toFixed(2)} />
            <Line label="USDC left to borrow on Aave" value={formatUsd(data.usdcLiquidity)} />
            <Line label="Network" value="Base" />
          </WhiteCard>

          <Link href="/guardian" className="flex items-center gap-3 rounded-[22px] bg-card px-4 py-3.5 no-underline shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-ink"><ShieldIcon size={16} /></span>
            <span className="flex flex-1 flex-col">
              <span className="text-[15px] font-semibold">Guardian</span>
              <span className="text-[12.5px] text-muted">Repays from savings so your stocks aren’t sold</span>
            </span>
            <ChevronRight className="text-subtle" />
          </Link>

          {data.borrowPaused && <p role="status" className="m-0 text-[13px] text-act">Borrowing is paused on Aave right now.</p>}

          <div className="grid grid-cols-2 gap-2.5">
            <Link href="/loan" className="flex h-[52px] items-center justify-center rounded-[26px] bg-card text-[15px] font-semibold no-underline shadow-[0_1px_3px_rgba(14,13,11,0.06)]">Add collateral</Link>
            <Link href="/unlock" className="flex h-[52px] items-center justify-center rounded-[26px] bg-card text-[15px] font-semibold no-underline shadow-[0_1px_3px_rgba(14,13,11,0.06)]">Unlock stocks</Link>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Link href="/loan" className="flex h-[52px] items-center justify-center rounded-[26px] bg-chip text-[15px] font-semibold no-underline">Get a loan</Link>
            <Link href="/repay" className="flex h-[52px] items-center justify-center rounded-[26px] bg-accent text-[15px] font-bold no-underline" style={{ boxShadow: "0 0 14px rgba(212,255,60,0.32)" }}>Repay</Link>
          </div>
        </>
      )}
      <TabBar />
    </div>
  );
}

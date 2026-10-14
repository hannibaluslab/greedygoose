"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Header } from "@/components/gg/Header";
import { TabBar } from "@/components/gg/TabBar";
import { CreditSheet } from "@/components/gg/CreditSheet";
import { Money, MoneyCompact } from "@/components/gg/Money";
import { StatusPill } from "@/components/gg/Status";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { ChevronRight, CreditIcon, InfoIcon, LockIcon, ReceiveIcon, RepayIcon, TradeIcon, UnlockIcon } from "@/components/gg/icons";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { useGuardian, type GuardianStatus } from "@/hooks/useGuardian";
import { ShieldIcon } from "@/components/gg/icons";
import { formatShares, formatUsd, formatUsdShort } from "@/lib/formatting";

export default function HomePage() {
  return <RequireAccount>{(address) => <Home address={address} />}</RequireAccount>;
}

/** Design board "2 · Home · portfolio: Rail" (HomeUpliftRail.dc.html). */
function Home({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  const guardian = useGuardian(address).status;
  const [sheet, setSheet] = useState(false);

  return (
    <div className="relative min-h-dvh">
      <Header address={address} />

      {isError && !data && (
        <div className="mx-5 mt-4 rounded-[22px] bg-card p-4 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          <p role="alert" className="text-[15px]">We couldn’t load your account from Base.</p>
          <button type="button" onClick={() => refetch()} className="mt-3 h-11 rounded-full bg-chip px-4 font-semibold">
            Try again
          </button>
        </div>
      )}

      {!data ? <Skeleton /> : <Loaded data={data} guardian={guardian} openCredit={() => setSheet(true)} />}

      <TabBar />
      {data && <CreditSheet open={sheet} data={data} guardian={guardian} onClose={() => setSheet(false)} />}
    </div>
  );
}

function Loaded({ data, guardian, openCredit }: { data: PositionData; guardian: GuardianStatus; openCredit: () => void }) {
  const total = data.stocksUsd + data.cashUsd;
  const held = data.holdings.filter((h) => h.freeShares + h.lockedShares > 0);
  const stocksUsd = data.stocksUsd;

  return (
    <>
      {/* Balance block: two columns split by a hairline, as in the design. */}
      <section className="flex flex-col gap-2.5 px-5 pt-[18px]">
        <div className="num grid grid-cols-[auto_1fr] items-baseline px-[16.75px]">
          <div className="flex items-center gap-1.5 pb-1">
            <span className="label">Total balance</span>
            <span title="Your stocks plus your cash. What you owe is shown separately." className="-m-1 flex size-6 items-center justify-center text-subtle">
              <InfoIcon />
            </span>
          </div>
          <Divided className="pb-1"><span className="label whitespace-nowrap">Credit available</span></Divided>
          <Money value={total} size={46} dollarSize={22} centsSize={19} />
          <Divided className="self-stretch">
            <span className="text-[30px] font-semibold leading-none tracking-[-0.03em]">{formatUsdShort(data.availableUsd)}</span>
          </Divided>
          <div className="pt-[5px] text-[13px] text-ink-mid">
            {data.debtUsd > 0 ? (
              <>You owe <span className="font-semibold text-ink">{formatUsd(data.debtUsd)}</span></>
            ) : (
              <>Nothing owed</>
            )}
          </div>
          <Divided className="pt-[5px] text-[13px] text-ink-mid">
            <span className="whitespace-nowrap"><span className="font-semibold text-safe">{(data.apr * 100).toFixed(1)}%</span> a year</span>
          </Divided>
        </div>
        <div className="px-0"><MarketBanner /></div>
      </section>

      {/* Quick actions. */}
      <section className="grid grid-cols-4 gap-2 px-5 pt-3.5">
        <Action href="/buy" label="Buy" icon={<TradeIcon />} />
        <Action href="/receive" label="Receive" icon={<ReceiveIcon />} />
        <Action href="/loan" label="Get a loan" icon={<CreditIcon />} />
        <Action href="/repay" label="Repay" icon={<RepayIcon />} />
      </section>

      {/* Cash + Credit cards. */}
      <section className="grid grid-cols-2 gap-2.5 px-5 pt-[18px]">
        <Link
          href={data.cashUsd >= 1 ? "/buy" : "/receive"}
          className="flex flex-col gap-2 rounded-[22px] bg-ink px-4 py-3.5 text-on-ink no-underline"
          style={{ boxShadow: "0 16px 32px -18px rgba(0,0,0,0.5)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Cash</span>
            <span className="flex h-[22px] items-center rounded-[6px] bg-[rgba(212,255,60,0.14)] px-[7px] font-mono text-[10px] font-medium tracking-[0.04em] text-brand">
              USDC
            </span>
          </div>
          <MoneyCompact value={data.cashUsd} size={26} centsClass="text-[#a8a294]" />
          <div className="-mt-1 flex flex-wrap items-center gap-1 text-[11px] text-[#a8a294]">
            <span>{data.cashUsd >= 1 ? "Buy stocks with it" : "Add USDC on Base"}</span>
            <ChevronRight size={12} />
          </div>
        </Link>
        <button
          type="button"
          onClick={openCredit}
          className="flex flex-col gap-2 rounded-[22px] bg-card px-4 py-3.5 text-left shadow-[0_1px_3px_rgba(14,13,11,0.06)]"
        >
          <div className="flex w-full items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              Credit
              {guardian === "on" && (
                <span title="Guardian is on" aria-label="Guardian is on" className="flex size-[18px] items-center justify-center rounded-full bg-brand text-ink">
                  <ShieldIcon size={10} />
                </span>
              )}
            </span>
            <StatusPill status={data.status} size="sm" />
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="num text-[26px] font-semibold tracking-[-0.03em]">{formatUsd(Math.ceil(data.debtUsd)).replace(/\.00$/, "")}</span>
            <span className="text-[13px] text-subtle">owed</span>
          </div>
          <div className="mt-auto flex w-full items-baseline justify-between text-xs">
            <span className="text-subtle">Cost</span>
            <span className="num font-semibold text-ink">{formatUsd(data.monthlyCostUsd)} / month</span>
          </div>
        </button>
      </section>

      {/* Portfolio rail. */}
      <section className="flex flex-col gap-2.5 px-5 pt-[17px]">
        <div className="flex h-[22px] items-center justify-between">
          <Link href="/portfolio" className="flex items-baseline gap-2 no-underline">
            <span className="text-lg font-semibold tracking-[-0.015em]">Portfolio</span>
            <span className="num text-sm text-subtle">{formatUsd(stocksUsd)}</span>
          </Link>
          <Link href="/portfolio" className="-my-[5px] -mr-1 flex h-8 items-center gap-0.5 px-1 text-[13px] font-medium text-ink-mid no-underline">
            See all <ChevronRight />
          </Link>
        </div>
        {held.length === 0 ? (
          <div className="mb-4 flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
            <p className="m-0 text-[15px]">You don’t hold any supported stocks yet.</p>
            <Link href="/buy" className="flex h-11 items-center justify-center rounded-[22px] bg-chip text-[15px] font-semibold no-underline">
              {data.cashUsd >= 1 ? `Buy stocks with your ${formatUsd(data.cashUsd)}` : "Buy stocks"}
            </Link>
          </div>
        ) : (
          <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-4 pt-0.5 [scrollbar-width:none]">
            {held.map((h) => {
              const value = h.freeUsd + h.lockedUsd;
              const lockedPct = value > 0 ? Math.round((h.lockedUsd / value) * 100) : 0;
              return (
                <Link
                  key={h.symbol}
                  href="/portfolio"
                  className="flex w-[111px] shrink-0 flex-col rounded-[22px] bg-card p-3 text-ink no-underline"
                  style={{ boxShadow: "0 1px 3px rgba(14,13,11,0.06), 0 12px 22px -16px rgba(14,13,11,0.28)" }}
                >
                  <div className="flex items-center justify-between">
                    <StockAvatar symbol={h.symbol} />
                    {lockedPct > 0 ? (
                      <span title={`${lockedPct}% is collateral`} className="num inline-flex h-4 items-center gap-[3px] whitespace-nowrap rounded-[8px] bg-ground pl-1.5 pr-[5px] text-[9.5px] font-semibold text-ink-2">
                        {lockedPct}%<LockIcon />
                      </span>
                    ) : (
                      <span title="Not collateral" className="inline-flex h-4 w-5 items-center justify-center rounded-[8px] border border-dashed border-[rgba(14,13,11,0.22)] text-subtle">
                        <UnlockIcon />
                      </span>
                    )}
                  </div>
                  <span className="mt-2 text-[12.5px] font-semibold">{h.name}</span>
                  <div className="mt-px"><MoneyCompact value={value} /></div>
                  <span className="mt-px whitespace-nowrap font-mono text-[10px] text-ink-mid">{formatUsd(h.priceUsd)} / share</span>
                  <span className="mt-2 flex items-center gap-[5px] whitespace-nowrap text-[11px]">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand shadow-[0_0_0_1px_rgba(14,13,11,0.18)]" />
                    <b className="font-semibold">{formatShares(h.freeShares + h.lockedShares)}</b>
                    <span className="text-subtle">shares</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

function Divided({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`ml-[18px] flex items-baseline justify-center gap-1 border-l border-[rgba(14,13,11,0.12)] pl-[18px] text-center ${className}`}>
      {children}
    </div>
  );
}

function Action({ label, icon, href, onClick }: { label: string; icon: ReactNode; href?: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="flex size-12 items-center justify-center rounded-3xl bg-ink text-on-ink">{icon}</span>
      <span className="text-center text-xs font-medium leading-[1.25] text-ink-2">{label}</span>
    </>
  );
  const cls = "flex flex-col items-center gap-[7px] no-underline";
  return href ? <Link href={href} className={cls}>{inner}</Link> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

function Skeleton() {
  return (
    <div aria-busy className="flex flex-col gap-4 px-5 pt-[18px]">
      <div className="h-[92px] animate-pulse rounded-[22px] bg-chip" />
      <div className="grid grid-cols-4 gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="mx-auto size-12 animate-pulse rounded-3xl bg-chip" />)}</div>
      <div className="grid grid-cols-2 gap-2.5"><div className="h-[108px] animate-pulse rounded-[22px] bg-chip" /><div className="h-[108px] animate-pulse rounded-[22px] bg-chip" /></div>
      <div className="h-[170px] animate-pulse rounded-[22px] bg-chip" />
    </div>
  );
}

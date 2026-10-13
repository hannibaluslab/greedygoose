"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { Money } from "@/components/gg/Money";
import { StatusPill } from "@/components/gg/Status";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { BackIcon, ChevronRight, LockIcon, MenuIcon, PlusIcon, TradeIcon, UnlockIcon } from "@/components/gg/icons";
import { usePosition } from "@/hooks/usePosition";
import { formatShares, formatUsd } from "@/lib/formatting";

export default function PortfolioPage() {
  return <RequireAccount>{(address) => <Portfolio address={address} />}</RequireAccount>;
}

/** Design board "10 · Portfolio (Invest tab)" (PortfolioPage.dc.html). */
function Portfolio({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const held = data?.holdings.filter((h) => h.freeShares + h.lockedShares > 0) ?? [];

  return (
    <div className="relative min-h-dvh">
      <div className="flex flex-col gap-4 px-5 pt-[58px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <Link href="/home" aria-label="Back" className="-ml-3 -mr-1 flex size-11 items-center justify-center text-ink"><BackIcon /></Link>
            <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Portfolio</h1>
          </div>
          <div className="flex items-center gap-2">
            {data && <Link href="/credit" aria-label="Credit status" className="flex h-8 items-center"><StatusPill status={data.status} /></Link>}
            <Link href="/settings" aria-label="Menu" className="-mr-2 flex size-10 items-center justify-center rounded-[20px] text-ink"><MenuIcon /></Link>
          </div>
        </div>

        {!data ? (
          <div aria-busy className="h-[300px] animate-pulse rounded-[22px] bg-chip" />
        ) : (
          <>
            <section className="num grid grid-cols-[auto_1fr] items-baseline px-[16.75px]">
              <span className="label pb-1">Portfolio</span>
              <Divided className="pb-1"><span className="label">Cash available</span></Divided>
              <Money value={data.stocksUsd} size={46} dollarSize={22} centsSize={19} />
              <Divided className="self-stretch"><span className="text-[30px] font-semibold leading-none tracking-[-0.03em]">{formatUsd(data.usdcBalance).replace(/\.\d+$/, "")}</span></Divided>
              <div className="pt-[5px] text-[13px] text-muted">
                <span className="font-semibold text-ink">{formatUsd(data.collateralUsd)}</span> as collateral
              </div>
              <Divided className="pt-[5px] text-[13px] text-muted">USDC</Divided>
            </section>

            <div className="grid grid-cols-2 gap-2.5">
              <Link href="/buy" className="flex h-[52px] items-center justify-center gap-2 rounded-[26px] bg-card text-[15px] font-semibold no-underline shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
                <TradeIcon size={18} />Buy stocks
              </Link>
              <Link
                href="/loan"
                className="flex h-[52px] items-center justify-center gap-2 rounded-[26px] bg-accent text-[15px] font-bold no-underline"
                style={{ boxShadow: "0 0 14px rgba(212,255,60,0.32)" }}
              >
                <PlusIcon size={18} />Add collateral
              </Link>
            </div>

            <div className="flex flex-col gap-2">
              <span className="label px-1">Your holdings</span>
              {held.length === 0 ? (
                <div className="rounded-[22px] bg-card p-4 text-[15px] shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
                  You don’t hold any supported stocks yet.{" "}
                  <Link href="/buy" className="font-semibold underline">Buy stocks</Link>
                </div>
              ) : (
                <div className="num rounded-[22px] bg-card px-[18px] py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
                  {held.map((h, i) => {
                    const value = h.freeUsd + h.lockedUsd;
                    const lockedPct = value > 0 ? Math.round((h.lockedUsd / value) * 100) : 0;
                    return (
                      <Link
                        key={h.symbol}
                        href={lockedPct > 0 ? `/unlock?s=${h.symbol}` : "/loan"}
                        className={`block px-0.5 py-3.5 text-ink no-underline ${i < held.length - 1 ? "border-b border-[#e7e1d2]" : ""}`}
                      >
                        <div className="flex items-center gap-2.5">
                          <StockAvatar symbol={h.symbol} size={40} />
                          <div className="min-w-0 grow">
                            <div className="whitespace-nowrap text-[15px] font-semibold leading-tight">{h.name}</div>
                            <div className="mt-0.5 whitespace-nowrap text-[13px] font-medium leading-snug text-muted">{formatShares(h.freeShares + h.lockedShares)} shares</div>
                          </div>
                          <div className="min-w-[84px] text-right">
                            <div className="whitespace-nowrap text-[15px] font-semibold leading-tight">{formatUsd(value)}</div>
                            <div className="mt-0.5 whitespace-nowrap font-mono text-xs leading-snug text-muted">{formatUsd(h.priceUsd)}</div>
                          </div>
                        </div>
                        <div className="mt-2.5 flex items-center gap-1.5">
                          <Chip>{formatShares(h.freeShares)} free</Chip>
                          {lockedPct > 0 ? (
                            <Chip className="ml-auto text-muted"><LockIcon size={10} />{lockedPct}% is collateral</Chip>
                          ) : (
                            <Chip className="ml-auto text-muted"><UnlockIcon size={10} />Not collateral</Chip>
                          )}
                          <ChevronRight className="shrink-0 text-[#b9b3a6]" />
                        </div>
                        {(h.paused || h.frozen) && <p className="m-0 mt-2 text-xs text-act">Aave has paused this stock for now.</p>}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
            <p className="m-0 px-1 text-xs leading-snug text-subtle">
              Prices are Aave’s protocol prices. Tokenized stocks track the share price; they are not company shares and carry no voting rights.
            </p>
          </>
        )}
      </div>
      <TabBar />
    </div>
  );
}

function Divided({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ml-[18px] flex items-baseline justify-center gap-1 border-l border-[rgba(14,13,11,0.12)] pl-[18px] text-center ${className}`}>{children}</div>;
}

function Chip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-ground px-[9px] py-1 text-[11.5px] leading-tight ${className}`}>
      {children}
    </span>
  );
}

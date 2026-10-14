"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { SubHeader, WhiteCard } from "@/components/gg/Screen";
import { AmountInput } from "@/components/gg/AmountInput";
import { BottomBar } from "@/components/gg/BottomBar";
import { LoanMeter } from "@/components/gg/LoanMeter";
import { StatusPill } from "@/components/gg/Status";
import { StockAvatar, tickerOf } from "@/components/gg/StockAvatar";
import { LockIcon } from "@/components/gg/icons";
import { TxButton, TxDone, TxError } from "@/components/gg/TxUi";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { useCollateralFactors, usePosition, type Holding, type PositionData } from "@/hooks/usePosition";
import { useTx } from "@/hooks/useTx";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { FILL_MARGIN, autoFill, combinedLoan } from "@/lib/aave/loan";
import { buildLoanCalls } from "@/lib/aave/tx";
import { monthlyCost } from "@/lib/aave/math";
import { needsExtraConfirm, statusFor } from "@/lib/risk/status";
import { rawToShares } from "@/lib/tokens/b20";
import { marketState } from "@/lib/market-hours";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";
import { formatShares, formatUsd } from "@/lib/formatting";

export default function UseCreditPage() {
  return <RequireAccount>{(address) => <Loan address={address} />}</RequireAccount>;
}

function Loan({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const cfs = useCollateralFactors(data?.holdings);
  if (!data || !cfs) {
    return <div className="px-5 pt-[54px]"><div aria-busy className="h-[520px] animate-pulse rounded-[22px] bg-chip" /></div>;
  }
  return <LoanForm address={address} data={data} cfs={cfs} />;
}

type Line = { holding: Holding; stock: ReserveAsset; cf: number };

/** Holdings worth less than this are tucked away so dust doesn’t crowd the screen. */
const SMALL_USD = 1;

/** Raw units to put in use for a fraction (0–1) of the free balance. 100% = exactly the free balance. */
const rawFor = (h: Holding, f: number) =>
  f >= 0.9999 ? h.freeRaw : f <= 0 ? 0n : (h.freeRaw * BigInt(Math.round(f * 1_000_000))) / 1_000_000n;
const usdFor = (h: Holding, raw: bigint, decimals: number) => (Number(raw) / 10 ** decimals) * h.priceUsd;

/**
 * Unified loan screen: choose how much of each stock to put in use and how much credit to take, then one button
 * opens JAW's own sheet for all of it. The screen says what moves, the status after and the risk, so there is no
 * review of ours (Adrian, 2026-10-15). Credit can be 0 (backing only).
 */
function LoanForm({ address, data, cfs }: { address: `0x${string}`; data: PositionData; cfs: Record<string, number> }) {
  const { isConnected } = useAccount();
  const tx = useTx();
  const fee = useFeeSupport();
  const [fractions, setFractions] = useState<Record<string, number>>({});
  const [raw, setRaw] = useState("");
  const [ack, setAck] = useState(false);
  const [sent, setSent] = useState<{ borrowed: number; locked: string[] } | null>(null);
  const [expandSmall, setExpandSmall] = useState(false);

  const lines: Line[] = useMemo(
    () =>
      data.holdings.flatMap((h) => {
        const stock = EQUITIES.find((e) => e.symbol === h.symbol);
        const cf = cfs[h.symbol] ?? 0;
        return stock && h.freeUsd >= 0.01 && cf > 0 && !h.paused && !h.frozen ? [{ holding: h, stock, cf }] : [];
      }).sort((a, b) => b.holding.freeUsd - a.holding.freeUsd),
    [data.holdings, cfs],
  );

  // Only tuck small holdings away when there are bigger ones to show — never hide someone's only stocks.
  const hasBig = lines.some((l) => l.holding.freeUsd >= SMALL_USD);
  const showSmall = expandSmall || !hasBig;
  const locks = lines.map((l) => {
    const r = rawFor(l.holding, fractions[l.stock.symbol] ?? 0);
    return { ...l, raw: r, usd: usdFor(l.holding, r, l.stock.decimals) };
  });
  const amount = Math.max(0, Number(raw.replace(/[^0-9.]/g, "")) || 0);
  const calc = combinedLoan({
    collateralUsd: data.collateralUsd,
    avgCf: data.avgCf,
    debtUsd: data.debtUsd,
    borrowUsd: amount,
    liquidityUsd: data.usdcLiquidity,
    locks: locks.map((l) => ({ key: l.stock.symbol, usd: l.usd, cf: l.cf, freeUsd: l.holding.freeUsd })),
  });
  // Never let a borrow go right up to Aave's line: interest and prices move between reading and signing.
  const hardMax = Math.floor(calc.maxAave * 0.995 * 100) / 100;
  const safeMax = Math.floor(calc.maxSafe * 100) / 100;
  const watchMax = Math.floor(calc.maxWatch * 100) / 100;
  const after = statusFor(data.debtUsd + amount > 0 ? calc.hfAfter : null);
  const lockingAny = locks.some((l) => l.raw > 0n);
  const overLimit = amount > hardMax;
  const risky = amount > 0 && needsExtraConfirm(after);
  const feeBlocked = isConnected && fee.state === "unsupported";
  const nothing = !lockingAny && amount === 0;
  const ready = !nothing && !overLimit && !(amount > 0 && data.borrowPaused);

  const fill = () => {
    const usd = autoFill({
      collateralUsd: data.collateralUsd,
      avgCf: data.avgCf,
      debtUsd: data.debtUsd,
      borrowUsd: amount,
      lines: locks.map((l) => ({ key: l.stock.symbol, usd: l.usd, cf: l.cf, freeUsd: l.holding.freeUsd })),
    });
    setFractions(Object.fromEntries(lines.map((l) => [l.stock.symbol, Math.min(1, ((usd[l.stock.symbol] ?? 0) * FILL_MARGIN) / l.holding.freeUsd)])));
  };
  // Only offer auto-fill when there's still free stock to lock.
  const needsFill = amount > 0 && amount > safeMax && locks.some((l) => l.raw < l.holding.freeRaw);

  if (tx.phase === "done" && sent) {
    return (
      <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
        <SubHeader label="Credit" />
        <TxDone
          title={sent.borrowed > 0 ? `You used ${formatUsd(sent.borrowed)} of credit` : "Backing added"}
          body={
            <>
              {sent.locked.length > 0 && <>{sent.locked.join(", ")} now {sent.locked.length > 1 ? "back" : "backs"} your credit. </>}
              {sent.borrowed > 0 ? "The USDC is in your account now." : "You can use credit against it any time."}
            </>
          }
          txHash={tx.txHash}
          onDone={() => {
            tx.reset();
            setSent(null);
            setRaw("");
            setFractions({});
            setAck(false);
          }}
        />
      </div>
    );
  }

  if (lines.length === 0 && data.collateralUsd === 0) {
    return (
      <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
        <SubHeader label="Credit" />
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Use credit</h1>
        <WhiteCard className="flex flex-col gap-3 p-[18px]">
          <p className="m-0 text-[15px]">Credit needs stocks to back it. Buy some with your USDC, or receive them.</p>
          <Link href="/buy" className="flex h-[52px] items-center justify-center rounded-[26px] bg-brand text-[15px] font-bold no-underline">Buy stocks</Link>
        </WhiteCard>
      </div>
    );
  }

  const summary = (
    <WhiteCard className="num px-4 py-0.5">
      <Row label="Credit limit" value={formatUsd(calc.powerUsd)} />
      <Row label="You owe after" value={formatUsd(data.debtUsd + amount)} />
      <Row label="Cost" value={`about ${formatUsd(monthlyCost(data.debtUsd + amount, data.apr))} / month`} />
      <Row label="Rate" value={`${(data.apr * 100).toFixed(2)}% a year, variable`} />
      <div className="flex items-center justify-between py-3 text-[15px]">
        <span className="text-ink-mid">Status</span>
        <span className="flex items-center gap-2"><StatusPill status={data.status} /> → <StatusPill status={after} /></span>
      </div>
    </WhiteCard>
  );

  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
      <SubHeader label="Credit" />
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Use credit</h1>
        <p className="m-0 text-sm text-ink-mid">Choose what backs it and how much to take. Nothing is sold.</p>
      </div>
      <MarketBanner />

      {data.collateralUsd > 0 && (
        <div className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink"><LockIcon size={12} /></span>
          <span className="flex flex-1 flex-col">
            <span className="text-[15px] font-semibold">Already backing</span>
            <span className="num text-[12.5px] text-ink-mid">{formatUsd(data.collateralUsd)} · you owe {formatUsd(data.debtUsd)}</span>
          </span>
          <Link href="/free-up" className="text-[13px] font-semibold text-ink-mid underline">Free up</Link>
        </div>
      )}

      {lines.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="label px-1">Back it with more</span>
          {locks.filter((l) => showSmall || l.holding.freeUsd >= SMALL_USD || l.raw > 0n).map((l) => {
            const f = fractions[l.stock.symbol] ?? 0;
            const shares = rawToShares(l.raw, l.holding.multiplier, l.stock.decimals);
            const on = l.raw > 0n;
            return (
              <div
                key={l.stock.symbol}
                className={`num flex flex-col gap-2.5 rounded-2xl bg-card px-3.5 py-3 ${on ? "border-[1.5px] border-ink" : "border border-[#e3ddcf]"}`}
              >
                <div className="flex items-center gap-3">
                  <StockAvatar symbol={l.stock.symbol} size={36} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[15px] font-semibold">{l.holding.name}</span>
                    <span className="whitespace-nowrap text-[12.5px] text-ink-mid">
                      {formatUsd(l.holding.freeUsd)} free · {Math.round(l.cf * 100)}% counts
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col text-right">
                    <span className="text-lg font-bold leading-[1.1] tracking-[-0.02em]">{formatUsd(l.usd)}</span>
                    <span className="whitespace-nowrap text-[11.5px] text-ink-mid">{on ? `${formatShares(shares)} ${tickerOf(l.stock.symbol)}` : "not in use"}</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(f * 100)}
                    aria-label={`Share of ${l.holding.name} to put in use`}
                    onChange={(e) => {
                      setAck(false);
                      setFractions((s) => ({ ...s, [l.stock.symbol]: Number(e.target.value) / 100 }));
                    }}
                    className="h-6 flex-1 accent-[#0e0d0b]"
                  />
                  <span className="w-10 text-right text-xs font-semibold text-ink-mid">{Math.round(f * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => setFractions((s) => ({ ...s, [l.stock.symbol]: f >= 0.9999 ? 0 : 1 }))}
                    className="h-7 rounded-[14px] bg-chip px-2.5 text-xs font-semibold text-ink-mid"
                  >
                    {f >= 0.9999 ? "None" : "All"}
                  </button>
                </div>
              </div>
            );
          })}
          {!showSmall && locks.some((l) => l.holding.freeUsd < SMALL_USD && l.raw === 0n) && (
            <button type="button" onClick={() => setExpandSmall(true)} className="h-10 text-[13px] font-semibold text-ink-mid">
              Show {locks.filter((l) => l.holding.freeUsd < SMALL_USD && l.raw === 0n).length} small holdings (under {formatUsd(SMALL_USD)})
            </button>
          )}
        </div>
      )}

      <WhiteCard className="flex flex-col gap-3 p-[18px] focus-within:shadow-[0_0_0_1.5px_#0e0d0b]">
        <label htmlFor="amount" className="text-[15px] font-semibold">How much USDC do you need?</label>
        <div className="flex items-center gap-2">
          <span className="text-[38px] font-semibold text-ink-mid">$</span>
          <AmountInput
            id="amount"
            value={raw}
            onValue={(v) => {
              setRaw(v);
              setAck(false);
            }}
            className="text-[44px] font-semibold tracking-[-0.04em]"
          />
          <button
            type="button"
            onClick={() => {
              setRaw(String(hardMax));
              setAck(false);
            }}
            className="h-8 shrink-0 rounded-2xl bg-chip px-3 font-mono text-xs font-medium tracking-[0.06em]"
          >
            MAX
          </button>
        </div>
        <p className={`m-0 text-[13px] ${overLimit ? "text-act" : "text-ink-mid"}`}>
          {overLimit
            ? `Aave won’t lend that much against these stocks. Back it with more, or take up to ${formatUsd(hardMax)}.`
            : `Up to ${formatUsd(hardMax)} (Aave’s limit). Stay under ${formatUsd(safeMax)} to be Safe.`}
        </p>
        {hardMax > 0 && <LoanMeter amount={amount} safe={safeMax} watch={watchMax} limit={hardMax} />}
        {needsFill && (
          <button type="button" onClick={fill} className="h-11 rounded-[22px] bg-ink text-[14px] font-semibold text-on-ink">
            Pick enough backing for {formatUsd(amount)}
          </button>
        )}
      </WhiteCard>

      {/* D7: everything that moves, in the one batch JAW's sheet signs. */}
      {!nothing && (
        <WhiteCard className="num px-4 py-1">
          <ol className="m-0 list-none p-0">
            {locks.filter((l) => l.raw > 0n).map((l) => (
              <li key={l.stock.symbol} className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
                <span className="flex items-center gap-2">
                  <StockAvatar symbol={l.stock.symbol} size={24} />
                  Put {formatShares(rawToShares(l.raw, l.holding.multiplier, l.stock.decimals))} {tickerOf(l.stock.symbol)} in use
                </span>
                <span className="font-semibold">{formatUsd(l.usd)}</span>
              </li>
            ))}
            {amount > 0 && (
              <li className="flex items-center justify-between py-3 text-[15px]">
                <span className="flex items-center gap-2">
                  <span aria-hidden className="flex size-6 items-center justify-center rounded-full bg-safe text-xs font-bold text-white">$</span>
                  USDC credit to your account
                </span>
                <span className="font-semibold">{formatUsd(amount)}</span>
              </li>
            )}
          </ol>
        </WhiteCard>
      )}
      {summary}
      {risky && (
        <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
          I understand this puts my loan in {after === "act" ? "Act" : "Watch"}. If my stocks fall, Aave can sell part of them.
        </label>
      )}
      <p className="m-0 text-xs leading-snug text-subtle">
        Shares in use stay in your account’s Aave position; nothing is sold. If they fall too far, Aave can sell part of
        them to repay what you owe. {!marketState().open && "Stock prices are paused until markets reopen and can jump when they do. "}
        Tokenized stocks track the share price; they are not company shares.
      </p>
      {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">Your account can’t pay network fees in USDC on Base right now.</p>}
      <TxError error={tx.error} />
      <BottomBar>
        <TxButton
          label={amount > 0 ? "Use credit" : "Add backing"}
          phase={tx.phase}
          preview={!isConnected}
          disabled={!ready || (risky && !ack) || feeBlocked || fee.loading}
          onClick={() => {
            if (tx.phase === "failed") tx.reset();
            const chosen = locks.filter((l) => l.raw > 0n);
            setSent({
              borrowed: amount,
              locked: chosen.map((l) => `${formatShares(rawToShares(l.raw, l.holding.multiplier, l.stock.decimals))} ${tickerOf(l.stock.symbol)}`),
            });
            void tx.run(
              address,
              buildLoanCalls({
                user: address,
                locks: chosen.map((l) => ({ stock: l.stock, raw: l.raw })),
                borrowRaw: amount > 0 ? parseUnits(amount.toFixed(USDC.decimals), USDC.decimals) : 0n,
              }),
              "This would fail right now — prices may have moved. Try a little less credit, or back it with a bit more.",
              [
                ...chosen.map((l) => ({ kind: "supply" as const, symbol: l.stock.symbol, amount: Number(l.raw) / 10 ** l.stock.decimals })),
                ...(amount > 0 ? [{ kind: "borrow" as const, symbol: "USDC", amount }] : []),
              ],
            );
          }}
        />
      </BottomBar>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-hairline py-3 text-[15px]">
      <span className="text-ink-mid">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

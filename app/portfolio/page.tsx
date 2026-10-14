"use client";

import { useSearchParams } from "next/navigation";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { TabHeader } from "@/components/gg/Screen";
import { BalanceHero } from "@/components/gg/BalanceHero";
import { Button } from "@/components/gg/Button";
import { BuySheet } from "@/components/gg/BuySheet";
import { HoldingList, HoldingRow } from "@/components/gg/Holding";
import { CreditIcon, TradeIcon } from "@/components/gg/icons";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { useSheetSubject } from "@/hooks/useSheetSubject";
import { aprToApy } from "@/lib/aave/math";
import { formatUsd } from "@/lib/formatting";

export default function PortfolioPage() {
  return <RequireAccount>{(address) => <Portfolio address={address} />}</RequireAccount>;
}

/**
 * Design board "10 · Portfolio (Invest tab)" (PortfolioPage.dc.html). Market opens Flow 1's sheet
 * (F1-3 → F1-4 → confirm); /buy lands here with ?market, or ?s=SYMBOL for one stock's Buy step.
 * Not drawn yet: today's change and the value line (price history, plan item 8) and "Your mix" (the
 * Rebalancer, item 9) have no data source.
 */
function Portfolio({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  const params = useSearchParams();
  const market = useSheetSubject<{ symbol: string | null }>(
    params.has("s") ? { symbol: params.get("s") } : params.has("market") ? { symbol: null } : null,
  );
  const openMarket = () => market.show({ symbol: null });

  return (
    <div className="relative min-h-dvh">
      <div className="flex flex-col gap-4 px-5 pt-[58px]">
        <TabHeader title="Portfolio" back="/home" status={data?.status} statusHref="/credit" />

        {isError && !data ? (
          <div className="rounded-[22px] bg-card p-4 shadow-card-elev">
            <p role="alert" className="m-0 text-[15px]">We couldn’t load your account from Base.</p>
            <button type="button" onClick={() => refetch()} className="mt-3 h-11 rounded-full bg-chip px-4 font-semibold">
              Try again
            </button>
          </div>
        ) : !data ? (
          <div aria-busy className="h-[300px] animate-pulse rounded-[22px] bg-chip" />
        ) : (
          <Loaded data={data} openMarket={openMarket} />
        )}
      </div>
      <TabBar />
      {data && market.subject && (
        <BuySheet key={market.key} open={market.open} user={address} data={data} symbol={market.subject.symbol} onClose={market.close} />
      )}
    </div>
  );
}

function Loaded({ data, openMarket }: { data: PositionData; openMarket: () => void }) {
  const held = data.holdings.filter((h) => h.freeShares + h.lockedShares > 0);
  return (
    <>
      <BalanceHero
        label="Portfolio"
        value={data.stocksUsd}
        side={{
          label: "Cash available",
          // Whole dollars, as drawn ("$400"), and never more than there is.
          value: formatUsd(Math.floor(data.cashUsd)).replace(/\.00$/, ""),
          sub: <><span className="font-semibold text-pos">{(aprToApy(data.savingsApr) * 100).toFixed(1)}%</span> APY</>,
        }}
      />

      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="white" icon={<TradeIcon size={18} strokeWidth={1.8} />} onClick={openMarket}>Market</Button>
        <Button href="/use-credit" icon={<CreditIcon size={18} strokeWidth={1.8} />}>Credit Buy</Button>
      </div>

      <HoldingList title="Your holdings">
        {held.length === 0 ? (
          <p className="m-0 py-4 text-[15px]">
            You don’t hold any supported stocks yet.{" "}
            <button type="button" onClick={openMarket} className="font-semibold underline">Buy stocks</button>
          </p>
        ) : (
          held.map((h) => {
            const value = h.freeUsd + h.lockedUsd;
            const backs = value > 0 ? h.lockedUsd / value : 0;
            return (
              <HoldingRow
                key={h.symbol}
                symbol={h.symbol}
                name={h.name}
                valueUsd={value}
                shares={h.freeShares + h.lockedShares}
                backs={backs}
                href={backs > 0 ? `/free-up?s=${h.symbol}` : "/use-credit"}
                note={h.paused || h.frozen ? "Aave has paused this stock for now." : undefined}
              />
            );
          })
        )}
      </HoldingList>
      <p className="m-0 px-1 text-xs leading-snug text-subtle">
        Prices are Aave’s protocol prices. Tokenized stocks track the share price; they are not company shares and carry no voting rights.
      </p>
    </>
  );
}

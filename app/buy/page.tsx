"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { SubHeader } from "@/components/gg/Screen";
import { BuySheet } from "@/components/gg/BuySheet";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { ChevronRight } from "@/components/gg/icons";
import { MarketBanner } from "@/components/ui/MarketBanner";
import { usePosition } from "@/hooks/usePosition";
import { EQUITIES } from "@/lib/tokens/registry";
import { formatShares, formatUsd } from "@/lib/formatting";

export default function BuyPage() {
  return <RequireAccount>{(address) => <Market address={address} />}</RequireAccount>;
}

/** Market list (design "F1 · 3 · Market"): every supported stock with Aave's price; tap to buy. */
function Market({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const initial = useSearchParams().get("s");
  const [selected, setSelected] = useState<string | null>(initial);
  const stock = EQUITIES.find((e) => e.symbol === selected);
  const holding = data?.holdings.find((h) => h.symbol === selected);

  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
      <SubHeader label="Market" />
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Buy stocks</h1>
        <p className="m-0 text-sm text-muted">
          With your cash{data ? <> · <span className="num font-semibold text-ink">{formatUsd(data.usdcBalance)}</span> available</> : null}
        </p>
      </div>
      <MarketBanner />
      {!data ? (
        <div aria-busy className="h-[420px] animate-pulse rounded-[22px] bg-chip" />
      ) : (
        <ul className="num m-0 list-none rounded-[22px] bg-card px-[18px] py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          {data.holdings.map((h, i) => (
            <li key={h.symbol} className={i < data.holdings.length - 1 ? "border-b border-[#e7e1d2]" : ""}>
              <button type="button" onClick={() => setSelected(h.symbol)} className="flex w-full items-center gap-2.5 px-0.5 py-3.5 text-left">
                <StockAvatar symbol={h.symbol} size={40} />
                <div className="min-w-0 grow">
                  <div className="text-[15px] font-semibold leading-tight">{h.name}</div>
                  <div className="mt-0.5 text-[13px] font-medium text-muted">
                    {h.freeShares + h.lockedShares > 0 ? `You have ${formatShares(h.freeShares + h.lockedShares)}` : h.symbol.replace(/c$/, "")}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[15px] font-semibold leading-tight">{formatUsd(h.priceUsd)}</div>
                  <div className="mt-0.5 font-mono text-xs text-subtle">per share</div>
                </div>
                <ChevronRight className="shrink-0 text-[#b9b3a6]" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-xs leading-snug text-subtle">
        Buys are swaps on Base (Aerodrome, or Uniswap if it’s cheaper), paid with your USDC. We compare every quote with Aave’s
        price and show you before you confirm. Not available to US persons.
      </p>

      {stock && holding && data && (
        <BuySheet user={address} stock={stock} oraclePriceUsd={holding.priceUsd} cashUsd={data.usdcBalance} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

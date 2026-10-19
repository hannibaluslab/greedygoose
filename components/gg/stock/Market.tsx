import type { ReactNode } from "react";
import { StockAvatar } from "../StockAvatar";
import { Tap } from "../Tap";
import { ChevronRight } from "../icons";
import { formatUsd, formatUsdShort } from "@/lib/formatting";

/** The Market sheet's list card (F1-3). */
export function MarketList({ children }: { children: ReactNode }) {
  return <div className="num rounded-[16px] border border-line-field bg-card leading-[normal]">{children}</div>;
}

/**
 * A stock in the Market sheet, as F1-3 draws every row: the name, "You own $2,000" when you hold some, the price
 * per share and a chevron. Stocks earn no yield (D19), so the boards' APY chip is left out.
 */
export function MarketRow({
  symbol,
  name,
  priceUsd,
  ownedUsd,
  onClick,
}: {
  symbol: string;
  name: string;
  priceUsd: number;
  /** What you hold, valued at Aave's price; 0 when you hold none. */ ownedUsd: number;
  onClick: () => void;
}) {
  const price = formatUsd(priceUsd);
  const owned = ownedUsd > 0;
  return (
    <Tap
      onClick={onClick}
      label={owned ? `${name}, you own ${formatUsdShort(ownedUsd)}, ${price} per share` : `${name}, ${price} per share`}
      className="group flex min-h-16 w-full items-stretch pl-4 text-left text-ink"
    >
      <span className="flex items-center py-2.5">
        <StockAvatar symbol={symbol} size={40} font={9.5} weight={800} />
      </span>
      <span className="ml-3 flex min-w-0 flex-1 items-center gap-3 border-b border-line-field py-2.5 pr-4 group-last:border-b-0">
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="truncate text-[15px] font-semibold leading-[18px]">{name}</span>
          {owned && (
            <span className="flex h-[22px] items-center whitespace-nowrap text-[13px] font-medium leading-[18px] text-ink-mid">
              <span>
                You own <b className="font-semibold text-ink">{formatUsdShort(ownedUsd)}</b>
              </span>
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="flex min-w-[76px] flex-col items-end gap-[3px] whitespace-nowrap">
            <span className="text-[15px] font-semibold leading-[18px]">{price}</span>
            <span className="text-[12px] font-medium leading-[22px] text-ink-mid">per share</span>
          </span>
          <ChevronRight strokeWidth={2.2} className="shrink-0 text-ink-faint" />
        </span>
      </span>
    </Tap>
  );
}

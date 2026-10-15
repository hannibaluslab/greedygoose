"use client";

import { BuySheet } from "./BuySheet";
import { CreditBuySheet } from "./CreditBuySheet";
import { StockSheet } from "./StockSheet";
import { TradeSheet } from "./TradeSheet";
import { UnlockSheet } from "./UnlockSheet";
import { useCollateralFactors, type Holding, type PositionData } from "@/hooks/usePosition";
import { useSheetSubject } from "@/hooks/useSheetSubject";
import type { TradeAsset } from "@/lib/trade";
import { EQUITIES, type ReserveAsset } from "@/lib/tokens/registry";

/** The stock sheet's subject: which stock, and whether the Market opened it (its Back returns there). */
type StockAt = { symbol: string; fromMarket?: boolean };
/** A flow's subject: its stock (none for the Market or F2-3's picker), and the stock sheet that opened it, to go back to. */
type FlowAt = { symbol: string | null; back?: StockAt };
/** The Trade sheet's subject: what it opens on, when not its defaults (Home and Invest pass none). */
type TradeAt = { from?: TradeAsset; to?: TradeAsset };

/**
 * What the sheets a page shows for its stocks are open for (Home, Invest). `initialBuy` opens the Market, or one
 * stock's Buy step, as the page loads (/buy, /buy?s=NVDAc).
 */
export function useStockSheets(initialBuy: FlowAt | null = null) {
  const stock = useSheetSubject<StockAt>();
  const buy = useSheetSubject<FlowAt>(initialBuy);
  const creditBuy = useSheetSubject<FlowAt>();
  const freeUp = useSheetSubject<FlowAt & { symbol: string }>();
  const trade = useSheetSubject<TradeAt>();
  return {
    stock,
    buy,
    creditBuy,
    freeUp,
    trade,
    openStock: (symbol: string) => stock.show({ symbol }),
    openMarket: () => buy.show({ symbol: null }),
    openCreditBuy: () => creditBuy.show({ symbol: null }),
    openTrade: (at: TradeAt = {}) => trade.show(at),
  };
}

export type StockSheetsState = ReturnType<typeof useStockSheets>;

/**
 * A stock's sheet and the flows it opens: Buy (Flow 1, whose Market rows open stock sheets), Credit Buy (Flow 2) and
 * Free up shares. One sheet slides out as the next slides in, and a flow opened from a stock's sheet goes Back to it.
 * Trade (Home's and Invest's) is its own sheet. Stocks resolve through the registry only.
 */
export function StockSheets({ sheets, user, data }: { sheets: StockSheetsState; user: `0x${string}`; data: PositionData }) {
  const { stock, buy, creditBuy, freeUp, trade } = sheets;
  const find = (symbol: string | null | undefined) => {
    const asset = EQUITIES.find((e) => e.symbol === symbol);
    const holding = data.holdings.find((h) => h.symbol === symbol);
    return asset && holding ? { asset, holding } : null;
  };
  const shown = find(stock.subject?.symbol);
  const freeing = find(freeUp.subject?.symbol);
  /** From a flow back to the stock sheet that opened it. */
  const backTo = (flow: { close: () => void }, at: StockAt | undefined) =>
    at
      ? () => {
          flow.close();
          stock.show(at);
        }
      : undefined;
  /** From the stock sheet on to a flow for its stock. */
  const hop = <T,>(flow: { show: (s: T) => void }, subject: T) => () => {
    stock.close();
    flow.show(subject);
  };

  return (
    <>
      {shown && stock.subject && (
        <StockSheet
          key={`stock${stock.key}`}
          open={stock.open}
          user={user}
          data={data}
          stock={shown.asset}
          holding={shown.holding}
          onClose={stock.close}
          onBack={
            stock.subject.fromMarket
              ? () => {
                  stock.close();
                  buy.show({ symbol: null });
                }
              : undefined
          }
          onBuy={hop(buy, { symbol: stock.subject.symbol, back: stock.subject })}
          onCreditBuy={hop(creditBuy, { symbol: stock.subject.symbol, back: stock.subject })}
          onFreeUp={hop(freeUp, { symbol: stock.subject.symbol, back: stock.subject })}
        />
      )}
      {buy.subject && (
        <BuySheet
          key={`buy${buy.key}`}
          open={buy.open}
          user={user}
          data={data}
          symbol={buy.subject.symbol}
          onClose={buy.close}
          onStock={(symbol) => {
            buy.close();
            stock.show({ symbol, fromMarket: true });
          }}
          onBack={backTo(buy, buy.subject.back)}
        />
      )}
      {creditBuy.subject && (
        <CreditBuySheet
          key={`creditBuy${creditBuy.key}`}
          open={creditBuy.open}
          user={user}
          data={data}
          symbol={creditBuy.subject.symbol}
          onClose={creditBuy.close}
          onBack={backTo(creditBuy, creditBuy.subject.back)}
        />
      )}
      {trade.subject && (
        <TradeSheet
          key={`trade${trade.key}`}
          open={trade.open}
          user={user}
          data={data}
          from={trade.subject.from}
          to={trade.subject.to}
          onClose={trade.close}
        />
      )}
      {freeing && freeUp.subject && (
        <FreeUp
          key={`freeUp${freeUp.key}`}
          open={freeUp.open}
          user={user}
          stock={freeing.asset}
          holding={freeing.holding}
          data={data}
          onClose={freeUp.close}
          onBack={backTo(freeUp, freeUp.subject.back)}
        />
      )}
    </>
  );
}

/** Free up shares, with the collateral factors read only once it opens. */
function FreeUp(p: {
  open: boolean;
  user: `0x${string}`;
  stock: ReserveAsset;
  holding: Holding;
  data: PositionData;
  onClose: () => void;
  onBack?: () => void;
}) {
  const cfs = useCollateralFactors(p.data.holdings);
  return <UnlockSheet {...p} cf={cfs?.[p.stock.symbol]} />;
}

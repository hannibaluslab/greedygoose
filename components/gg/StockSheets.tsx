"use client";

import { BuySheet } from "./BuySheet";
import { CreditBuySheet } from "./CreditBuySheet";
import { StockSheet } from "./StockSheet";
import { TradeSheet } from "./TradeSheet";
import type { PositionData } from "@/hooks/usePosition";
import { useMoneySheets } from "./MoneySheets";
import { useSheetSubject } from "@/hooks/useSheetSubject";
import type { TradeAsset } from "@/lib/trade";
import { EQUITIES } from "@/lib/tokens/registry";

/** The stock sheet's subject: which stock, and whether the Market opened it (its Back returns there). */
type StockAt = { symbol: string; fromMarket?: boolean };
/**
 * A flow's subject: its stock (none for the Market or F2-3's picker), and the stock sheet that opened it, to go back
 * to; or, for a Buy opened from Credit Buy with no credit to use, `fromCreditBuy`: that Credit Buy's own subject, so
 * Back returns to it as it was (its stock, and the stock sheet it goes back to).
 */
type FlowAt = { symbol: string | null; back?: StockAt; fromCreditBuy?: Omit<FlowAt, "fromCreditBuy"> };
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
  const trade = useSheetSubject<TradeAt>();
  return {
    stock,
    buy,
    creditBuy,
    trade,
    openStock: (symbol: string) => stock.show({ symbol }),
    openMarket: () => buy.show({ symbol: null }),
    openCreditBuy: () => creditBuy.show({ symbol: null }),
    openTrade: (at: TradeAt = {}) => trade.show(at),
  };
}

type StockSheetsState = ReturnType<typeof useStockSheets>;

/**
 * A stock's sheet and the flows it opens: Buy (Flow 1, whose Market rows open stock sheets), Credit Buy (Flow 2) and
 * Free up shares. One sheet slides out as the next slides in, and a flow opened from a stock's sheet goes Back to it.
 * Trade (Home's and Invest's) is its own sheet. Stocks resolve through the registry only.
 */
export function StockSheets({
  sheets,
  user,
  data,
}: {
  sheets: StockSheetsState;
  user: `0x${string}`;
  data: PositionData;
}) {
  const { stock, buy, creditBuy, trade } = sheets;
  const money = useMoneySheets();
  const find = (symbol: string | null | undefined) => {
    const asset = EQUITIES.find((e) => e.symbol === symbol);
    const holding = data.holdings.find((h) => h.symbol === symbol);
    return asset && holding ? { asset, holding } : null;
  };
  const shown = find(stock.subject?.symbol);
  /** From a flow back to the stock sheet that opened it. */
  const backTo = (flow: { close: () => void }, at: StockAt | undefined) =>
    at
      ? () => {
          flow.close();
          stock.show(at);
        }
      : undefined;
  /** A Buy with cash opened from Credit Buy goes Back to that Credit Buy as it was (its stock, its way back). */
  const cashFrom = buy.subject?.fromCreditBuy;
  const creditAt = creditBuy.subject;
  /** From the stock sheet on to a flow for its stock. */
  const hop =
    <T,>(flow: { show: (s: T) => void }, subject: T) =>
    () => {
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
          onFreeUp={() => {
            stock.close();
            money.repay(stock.subject!.symbol);
          }}
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
          onBack={
            cashFrom
              ? () => {
                  buy.close();
                  creditBuy.show(cashFrom);
                }
              : backTo(buy, buy.subject.back)
          }
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
          onBuyWithCash={(symbol) => {
            creditBuy.close();
            buy.show({ symbol, fromCreditBuy: { symbol: creditAt?.symbol ?? null, back: creditAt?.back } });
          }}
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
    </>
  );
}

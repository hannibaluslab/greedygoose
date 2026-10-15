"use client";

import { useRef, useState } from "react";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountArrow, AmountBadge, AmountField, YouGet, YouGetCash } from "./AmountField";
import { AssetPicker, assetMark, type PickerRow } from "./AssetPicker";
import { Button } from "./Button";
import { SmallPrint } from "./BuySheet";
import { SellSmallPrint } from "./StockSheet";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { NETWORK_FEE_ROW, Summary } from "./Summary";
import { TxButton, TxDone, TxError } from "./TxUi";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuyQuote, useBuyQuoteRaw } from "@/hooks/useBuyQuote";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { PositionData } from "@/hooks/usePosition";
import { useSellQuote } from "@/hooks/useSell";
import { useTrade } from "@/hooks/useTrade";
import { formatShares } from "@/lib/formatting";
import { minOut, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import {
  TRADE_COPY,
  clampAmount,
  defaultLegs,
  emptyLine,
  fromOptions,
  planTrade,
  routeOf,
  swapSmallPrint,
  toOptions,
  tradeAmount,
  type AssetOption,
  type TradeAsset,
  type TradeRoute,
} from "@/lib/trade";

type Legs = { from: TradeAsset; to: TradeAsset };
/** What went to JAW's sheet, for what the sheet says once it lands. */
type Signed = { route: TradeRoute; from: TradeAsset; to: TradeAsset; sharesRaw: bigint };

/** A tap that just closed a picker's list doesn't also close the sheet (the dim and Close both report it). */
const MENU_TAP_MS = 500;

const pickerRows = (options: AssetOption[]): PickerRow[] =>
  options.map((o) => ({ id: o.asset, name: o.name, mark: assetMark(o.asset, 32), sub: o.sub, right: o.right, rightSub: o.rightSub, disabled: o.disabled }));

/**
 * Trade (Adrian, 2026-10-15): "the same as nym where you can swap between any assets you have". NYM's MoveSheet in
 * the kit: the From card (Cash, or a stock's free shares) over the To card (Cash or any of the seven stocks), the flip
 * button between them, an amount in dollars with MAX, what you get and the price, the network fee, and one button
 * that opens JAW's sheet once. cash → stock is the Buy step's batch, stock → cash the free-shares sale, stock → stock
 * both in one batch (useTrade). No confirm screen of ours: the small print says every move (D7). `from`/`to` seed the
 * legs. A buy or a trade lands on Home with its toast (useBoughtHome); a sale says so here.
 */
export function TradeSheet({
  open, user, data, from: seedFrom, to: seedTo, onClose,
}: {
  open: boolean;
  user: `0x${string}`;
  data: PositionData;
  from?: TradeAsset;
  to?: TradeAsset;
  onClose: () => void;
}) {
  const { isConnected } = useAccount();
  const fee = useFeeSupport();
  const { trade, phase, error, reset, busy, txHash } = useTrade();
  const [picked, setPicked] = useState<Legs | null>(() => defaultLegs(data, { from: seedFrom, to: seedTo }));
  // Opened with nothing to trade: the legs appear once there is something (money arrives while it's open).
  const legs = picked ?? defaultLegs(data, { from: seedFrom, to: seedTo });
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [menu, setMenu] = useState<"from" | "to" | null>(null);
  const menuClosedAt = useRef(0);
  const [signed, setSigned] = useState<Signed | null>(null);

  const from = legs?.from ?? "cash";
  const to = legs?.to ?? "cash";
  const input = { from, to, amount, all, data };
  // The quotes each route needs: the sale's for its shares (debounced), the buy's for the typed dollars (debounced), and
  // a swap's buy for the sale's floor once the sale's quote is in.
  const a = tradeAmount(input);
  const selling = a.route === "sell" || a.route === "swap";
  const sellQuote = useSellQuote(legs && selling ? a.fromStock : undefined, a.sharesRaw);
  const swapIn = planTrade({ ...input, sell: sellQuote }).buyInRaw;
  const cashBuyQuote = useBuyQuote(legs && a.route === "buy" ? a.toStock : undefined, a.amountUsd);
  const swapBuyQuote = useBuyQuoteRaw(legs && a.route === "swap" ? a.toStock : undefined, a.route === "swap" ? swapIn : 0n);
  const view = planTrade({ ...input, sell: sellQuote, buy: a.route === "buy" ? cashBuyQuote : swapBuyQuote });

  // Once a buy or a trade lands: Home, with "Bought 0.4554 NVDA" or "Traded NVDA for 0.0086 AAPL" from the receipt.
  useBoughtHome({
    phase: signed && signed.route !== "sell" ? phase : "idle",
    user,
    symbol: signed?.to ?? "",
    from: signed?.route === "swap" ? signed.from : undefined,
    txHash,
    onClose,
  });

  const fresh = () => {
    if (phase === "failed") reset();
  };
  /** New legs keep the dollars, clamped to what the new From takes. */
  const setLegs = (next: Legs) => {
    fresh();
    setPicked(next);
    const c = clampAmount(next.from, data, amount);
    setAmount(c.amount);
    setAll(c.all);
  };
  const flip = () => setLegs({ from: to, to: from });
  const pick = (which: "from" | "to", asset: TradeAsset) => {
    setMenu(null);
    const other = which === "from" ? to : from;
    if (asset === other) return flip();
    const next = which === "from" ? { from: asset, to } : { from, to: asset };
    // Cash to cash is no trade: a stock picked From with Cash To stays; Cash picked From needs a stock To.
    if (!routeOf(next.from, next.to)) return;
    setLegs(next);
  };
  const onValue = (v: string) => {
    fresh();
    const c = clampAmount(from, data, v);
    setAmount(c.amount);
    setAll(c.all);
  };
  const onMax = () => {
    fresh();
    setAmount(String(view.maxUsd));
    setAll(from !== "cash");
  };
  const closeMenu = () => {
    menuClosedAt.current = Date.now();
    setMenu(null);
  };
  const toggle = (which: "from" | "to") => setMenu((m) => (m === which ? null : which));
  // Escape, the dim and Close come here: an open list closes first, and the tap that closed it closes nothing else.
  const onOpenChange = (next: boolean) => {
    if (next) return;
    if (menu) return setMenu(null);
    if (Date.now() - menuClosedAt.current < MENU_TAP_MS) return;
    onClose();
  };

  const feeBlocked = isConnected && fee.state === "unsupported";
  const doneSale = phase === "done" && signed?.route === "sell";
  const sign = () => {
    if (!view.ready) return;
    fresh();
    const { route, fromStock, toStock, fromHolding, sellQuote: sq, sellPlan, buyQuote: bq } = view;
    if (route === "buy" && toStock && bq) {
      setSigned({ route, from, to, sharesRaw: 0n });
      void trade({ route, user, stock: toStock, quote: bq });
    } else if (route === "sell" && fromStock && fromHolding && sq && sellPlan) {
      setSigned({ route, from, to, sharesRaw: sellPlan.sharesRaw });
      void trade({ route, user, stock: fromStock, quote: sq, plan: sellPlan, oraclePriceUsd: fromHolding.priceUsd, debtRaw: data.debtRaw });
    } else if (route === "swap" && fromStock && toStock && fromHolding && sq && sellPlan && bq) {
      setSigned({ route, from, to, sharesRaw: sellPlan.sharesRaw });
      void trade({
        route,
        user,
        from: fromStock,
        to: toStock,
        sellQuote: sq,
        plan: sellPlan,
        buyQuote: bq,
        oraclePriceUsd: fromHolding.priceUsd,
        feeFromSale: view.feeFromSale,
      });
    }
  };

  const nameOf = (asset: TradeAsset) => (asset === "cash" ? TRADE_COPY.cashName : (data.holdings.find((h) => h.symbol === asset)?.name ?? asset));
  const fromHolding = data.holdings.find((h) => h.symbol === from);
  const toHolding = data.holdings.find((h) => h.symbol === to);
  const soldHolding = data.holdings.find((h) => h.symbol === signed?.from);
  const picker = (which: "from" | "to") => {
    const asset = which === "from" ? from : to;
    return (
      <AssetPicker
        label={which === "from" ? TRADE_COPY.fromPill(nameOf(asset)) : TRADE_COPY.toPill(nameOf(asset))}
        title={which === "from" ? TRADE_COPY.fromMenu : TRADE_COPY.toMenu}
        name={nameOf(asset)}
        mark={assetMark(asset, 18)}
        rows={pickerRows(which === "from" ? fromOptions(data) : toOptions(data))}
        selected={asset}
        open={menu === which}
        onToggle={() => toggle(which)}
        onClose={closeMenu}
        onPick={(id) => pick(which, id)}
        disabled={busy}
      />
    );
  };

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} title={TRADE_COPY.title}>
      <SheetSteps stepKey={doneSale ? "done" : "trade"} className="flex flex-col gap-3">
        {doneSale && signed ? (
          <TxDone
            title={TRADE_COPY.sold(
              formatShares(rawToShares(signed.sharesRaw, soldHolding?.multiplier ?? 10n ** 18n, view.fromStock?.decimals ?? 8)),
              tickerOf(signed.from),
            )}
            body={TRADE_COPY.soldBody}
            txHash={txHash}
            onDone={onClose}
          />
        ) : !legs ? (
          <div className="flex flex-col items-start gap-3 pt-1">
            <h3 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">{TRADE_COPY.emptyTitle}</h3>
            <p className="m-0 text-[14px] leading-[1.4] text-ink-mid">{emptyLine(data)}</p>
            <Button variant="dark" href="/receive" className="mt-1 w-full">{TRADE_COPY.topUp}</Button>
          </div>
        ) : (
          <>
            <AmountField
              label={view.fromLabel}
              source={picker("from")}
              badge={from === "cash" ? <AmountBadge kind="cash" /> : <StockAvatar symbol={from} />}
              value={amount}
              onValue={onValue}
              onMax={view.maxUsd > 0 ? onMax : undefined}
              disabled={busy}
              hint={
                <>
                  {view.hint.map((line) => (
                    <span key={line} className="block">{line}</span>
                  ))}
                </>
              }
            />
            <AmountArrow onFlip={flip} disabled={busy} />
            {view.youGet.kind === "stock" ? (
              <YouGet symbol={view.youGet.symbol} shares={view.youGet.shares} priceUsd={view.youGet.priceUsd} source={picker("to")} />
            ) : (
              <YouGetCash usd={view.youGet.usd} priceUsd={view.youGet.priceUsd} source={picker("to")} />
            )}
            <Summary rows={[...view.rows, NETWORK_FEE_ROW]} />
            {view.note && (
              <p role="status" className={`m-0 text-[13px] leading-snug ${view.note.tone === "act" ? "text-act" : "text-watch-text"}`}>
                {view.note.text}
              </p>
            )}
            {view.ready && view.route === "buy" && view.toStock && view.buyQuote && (
              <SmallPrint
                data={data}
                stock={view.toStock}
                econ={quoteEconomics(view.buyQuote, view.toStock, toHolding?.priceUsd ?? 0)}
                minShares={Number(minOut(view.buyQuote.amountOut)) / 10 ** view.toStock.decimals}
                venue={VENUE_LABEL[view.buyQuote.venue]}
                credit={null}
              />
            )}
            {view.ready && view.route === "sell" && view.fromStock && fromHolding && view.sellQuote && view.sellPlan && (
              <SellSmallPrint stock={view.fromStock} holding={fromHolding} quote={view.sellQuote} plan={view.sellPlan} />
            )}
            {view.ready && view.route === "swap" && view.fromStock && view.toStock && fromHolding && view.sellQuote && view.sellPlan && view.buyQuote && (
              <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
                {swapSmallPrint({
                  from: view.fromStock,
                  to: view.toStock,
                  fromHolding,
                  sellQuote: view.sellQuote,
                  plan: view.sellPlan,
                  buyQuote: view.buyQuote,
                })}
              </p>
            )}
            {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">{TRADE_COPY.feeUnsupported}</p>}
            <TxError error={error} />
            <div className="mt-1">
              <TxButton
                label={view.button}
                size="md"
                phase={phase}
                preview={!isConnected}
                disabled={!view.ready || feeBlocked || fee.loading || phase === "done"}
                onClick={sign}
              />
            </div>
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

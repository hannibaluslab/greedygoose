"use client";

import { EQUITIES } from "@/lib/tokens/registry";
import { useState, type ComponentProps } from "react";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { AmountArrow, AmountBadge, AmountField, AmountHintLine, YouGetCash, YouGetShares } from "../kit/AmountField";
import { AssetPicker, assetMark, type PickerRow } from "../kit/AssetPicker";
import { Button } from "../kit/Button";
import { useMoneySheets } from "../cash/MoneySheets";
import { SmallPrint } from "./BuySheet";
import { SellSmallPrint } from "./StockSheet";
import { StockAvatar, tickerOf } from "../kit/StockAvatar";
import { Summary } from "../home/Summary";
import { TxButton, TxDone, TxError } from "../TxUi";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuyQuote, useBuyQuoteRaw } from "@/hooks/useBuyQuote";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useMenuGuard } from "@/hooks/useMenuGuard";
import type { PositionData } from "@/hooks/usePosition";
import { useSellQuote } from "@/hooks/useSell";
import { useTrade } from "@/hooks/useTrade";
import type { TradeSign } from "@/lib/tx/plans";
import { formatShares } from "@/lib/formatting";
import { minOut, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import {
  TRADE_COPY,
  defaultLegs,
  emptyLine,
  fromOptions,
  planTrade,
  swapSmallPrint,
  toOptions,
  tradeAmount,
  tradeForm,
  type AssetOption,
  type TradeAction,
  type TradeAsset,
  type TradeForm,
  type TradeRoute,
} from "@/lib/trade";

/** What went to JAW's sheet, for what the sheet says once it lands. */
type Signed = { route: TradeRoute; from: TradeAsset; to: TradeAsset; sharesRaw: bigint };

const pickerRows = (options: AssetOption[]): PickerRow[] =>
  options.map((o) => ({
    id: o.asset,
    name: o.name,
    mark: assetMark(o.asset, 32),
    sub: o.sub,
    right: o.right,
    rightSub: o.rightSub,
    disabled: o.disabled,
  }));

/** With nothing to trade, the legs read as cash to cash (no route, nothing quoted). */
const NO_LEGS = { from: "cash", to: "cash" } as const;

/** A buy or a trade that went to JAW's sheet lands on Home; a sale stays here ("idle" to useBoughtHome). */
const boughtOf = (signed: Signed | null, phase: ReturnType<typeof useTrade>["phase"]) => ({
  phase: signed && signed.route !== "sell" ? phase : ("idle" as const),
  symbol: signed?.to ?? "",
  from: signed?.route === "swap" ? signed.from : undefined,
});

/**
 * Trade (Adrian, 2026-10-15): "the same as nym where you can swap between any assets you have". NYM's MoveSheet in
 * the kit: the From card (Cash, or a stock's free shares) over the To card (Cash or any of the seven stocks), the flip
 * button between them, an amount in dollars with MAX, what you get and the price, the network fee, and one button
 * that opens JAW's sheet once. cash → stock is the Buy step's batch, stock → cash the free-shares sale, stock → stock
 * both in one batch (useTrade). No confirm screen of ours: the small print says every move (D7). `from`/`to` seed the
 * legs. A buy or a trade lands on Home with its toast (useBoughtHome); a sale says so here.
 */
export function TradeSheet({
  open,
  user,
  data,
  from: seedFrom,
  to: seedTo,
  onClose,
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
  const money = useMoneySheets();
  const [form, setForm] = useState<TradeForm>(() => ({
    legs: defaultLegs(data, { from: seedFrom, to: seedTo }),
    amount: "",
    all: false,
  }));
  // Opened with nothing to trade: the legs appear once there is something (money arrives while it's open).
  const legs = form.legs ?? defaultLegs(data, { from: seedFrom, to: seedTo });
  const { amount, all } = form;
  const { menu, setMenu, closeMenu, onOpenChange } = useMenuGuard<"from" | "to" | null>(onClose, null);
  const [signed, setSigned] = useState<Signed | null>(null);

  const { from, to } = legs ?? NO_LEGS;
  const view = useTradeView({ from, to, amount, all, data }, !!legs);
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What the button would sign now, per route, prepared while the sheet is idle so the tap opens JAW's sheet at once.
  const toPriceUsd = data.holdings.find((h) => h.symbol === to)?.priceUsd ?? 0;
  const signable = open && !feeBlocked ? tradeSign(view, user, data.debtRaw, toPriceUsd) : null;
  const { sign: signTrade, phase, error, reset, busy, txHash, checking, blocked } = useTrade(signable);

  // Once a buy or a trade lands: Home, with "Bought 0.4554 NVDA" or "Traded NVDA for 0.0086 AAPL" from the receipt.
  useBoughtHome({ ...boughtOf(signed, phase), user, txHash, onClose });

  const fresh = () => {
    if (phase === "failed") reset();
  };
  /** The legs and the amount move only through `tradeForm` (lib/trade.ts): flip, pick, typed dollars, MAX. */
  const dispatch = (action: TradeAction) => {
    fresh();
    setForm((f) => tradeForm({ ...f, legs: f.legs ?? legs }, action, data));
  };
  const flip = () => dispatch({ type: "flip" });
  const pick = (which: "from" | "to", asset: TradeAsset) => {
    setMenu(null);
    dispatch({ type: "pick", which, asset });
  };
  const onValue = (value: string) => dispatch({ type: "amount", value });
  const onMax = () => dispatch({ type: "max" });
  const toggle = (which: "from" | "to") => setMenu((m) => (m === which ? null : which));

  const doneSale = phase === "done" && signed?.route === "sell";
  const sign = () => {
    if (!signable) return;
    fresh();
    setSigned({ route: signable.route, from, to, sharesRaw: signable.route === "buy" ? 0n : signable.plan.sharesRaw });
    void signTrade();
  };

  const nameOf = (asset: TradeAsset) =>
    asset === "cash" ? TRADE_COPY.cashName : (data.holdings.find((h) => h.symbol === asset)?.name ?? asset);
  const fromHolding = data.holdings.find((h) => h.symbol === from);
  const toHolding = data.holdings.find((h) => h.symbol === to);
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
          <SoldDone signed={signed} data={data} decimals={view.fromStock?.decimals} txHash={txHash} onDone={onClose} />
        ) : !legs ? (
          <div className="flex flex-col items-start gap-3 pt-1">
            <h3 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">{TRADE_COPY.emptyTitle}</h3>
            <p className="m-0 text-[14px] leading-[1.4] text-ink-mid">{emptyLine(data)}</p>
            <Button
              variant="dark"
              onClick={() => {
                onClose();
                money.topUp();
              }}
              className="mt-1 w-full"
            >
              {TRADE_COPY.topUp}
            </Button>
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
              hint={<AmountHintLine hint={view.hint} />}
            />
            <AmountArrow onFlip={flip} disabled={busy} />
            {view.youGet.kind === "stock" ? (
              <YouGetShares
                symbol={view.youGet.symbol}
                shares={view.youGet.shares}
                priceUsd={view.youGet.priceUsd}
                source={picker("to")}
              />
            ) : (
              <YouGetCash usd={view.youGet.usd} source={picker("to")} />
            )}
            <Summary rows={view.rows} />
            {view.note && (
              <p
                role="status"
                className={`m-0 text-[13px] leading-snug ${view.note.tone === "act" ? "text-act" : "text-watch-text"}`}
              >
                {view.note.text}
              </p>
            )}
            <TradeSmallPrint view={view} data={data} fromHolding={fromHolding} toHolding={toHolding} />
            {feeBlocked && (
              <p role="alert" className="m-0 text-[13px] text-act">
                {TRADE_COPY.feeUnsupported}
              </p>
            )}
            <TxError error={error} />
            <div className="mt-1">
              <TxButton
                label={view.button}
                size="md"
                phase={phase}
                checking={checking}
                preview={!isConnected}
                disabled={!signable || fee.loading || blocked || phase === "done"}
                onClick={sign}
              />
            </div>
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

/** What the Trade sheet signs for the route on screen, once it's ready (the quotes and the plan its screen shows). */
function tradeSign(
  view: ReturnType<typeof planTrade>,
  user: `0x${string}`,
  debtRaw: bigint,
  toPriceUsd: number,
): TradeSign | null {
  if (!view.ready) return null;
  const { route, fromStock, toStock, fromHolding, sellQuote: sq, sellPlan, buyQuote: bq } = view;
  if (route === "buy" && toStock && bq) return { route, user, stock: toStock, quote: bq, oraclePriceUsd: toPriceUsd };
  if (route === "sell" && fromStock && fromHolding && sq && sellPlan)
    return { route, user, stock: fromStock, quote: sq, plan: sellPlan, oraclePriceUsd: fromHolding.priceUsd, debtRaw };
  if (route === "swap" && fromStock && toStock && fromHolding && sq && sellPlan && bq)
    return {
      route,
      user,
      from: fromStock,
      to: toStock,
      sellQuote: sq,
      plan: sellPlan,
      buyQuote: bq,
      oraclePriceUsd: fromHolding.priceUsd,
      toPriceUsd,
      feeFromSale: view.feeFromSale,
    };
  return null;
}

/**
 * The quotes each route needs and the plan from them: the sale's for its shares (debounced), the buy's for the typed
 * dollars (debounced), and a swap's buy for the sale's floor once the sale's quote is in. Nothing is quoted without legs.
 */
function useTradeView(input: Omit<Parameters<typeof planTrade>[0], "buy" | "sell">, hasLegs: boolean) {
  const a = tradeAmount(input);
  const selling = a.route === "sell" || a.route === "swap";
  const sellQuote = useSellQuote(hasLegs && selling ? a.fromStock : undefined, a.sharesRaw);
  const swapIn = planTrade({ ...input, sell: sellQuote }).buyInRaw;
  const cashBuyQuote = useBuyQuote(hasLegs && a.route === "buy" ? a.toStock : undefined, a.amountUsd);
  const swapBuyQuote = useBuyQuoteRaw(
    hasLegs && a.route === "swap" ? a.toStock : undefined,
    a.route === "swap" ? swapIn : 0n,
  );
  return planTrade({ ...input, sell: sellQuote, buy: a.route === "buy" ? cashBuyQuote : swapBuyQuote });
}

/** A sale that landed: what was sold, and that the money is in the cash. */
function SoldDone({
  signed,
  data,
  decimals,
  txHash,
  onDone,
}: {
  signed: Signed;
  data: PositionData;
  decimals: number | undefined;
  txHash: ComponentProps<typeof TxDone>["txHash"];
  onDone: () => void;
}) {
  return (
    <TxDone
      title={TRADE_COPY.sold(
        formatShares(
          rawToShares(
            signed.sharesRaw,
            data.holdings.find((h) => h.symbol === signed.from)?.multiplier ?? 10n ** 18n,
            decimals ?? 8,
          ),
        ),
        EQUITIES.find((e) => e.symbol === signed.from)?.name ?? tickerOf(signed.from),
      )}
      body={TRADE_COPY.soldBody}
      txHash={txHash}
      onDone={onDone}
    />
  );
}

/** The small print for the route on screen once it's ready (D7): the buy's, the sale's, or both moves of a trade. */
function TradeSmallPrint({
  view,
  data,
  fromHolding,
  toHolding,
}: {
  view: ReturnType<typeof planTrade>;
  data: PositionData;
  fromHolding: PositionData["holdings"][number] | undefined;
  toHolding: PositionData["holdings"][number] | undefined;
}) {
  return (
    <>
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
      {view.ready &&
        view.route === "swap" &&
        view.fromStock &&
        view.toStock &&
        fromHolding &&
        view.sellQuote &&
        view.sellPlan &&
        view.buyQuote && (
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
    </>
  );
}

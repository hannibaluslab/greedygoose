"use client";

import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountArrow, AmountBadge, AmountField, AmountSource, YouGet } from "./AmountField";
import { Button } from "./Button";
import { MarketList, MarketRow } from "./Market";
import { StatusChange } from "./Status";
import { tickerOf } from "./StockAvatar";
import { NETWORK_FEE_ROW, Summary, type SummaryRow } from "./Summary";
import { TxButton, TxError } from "./TxUi";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuy } from "@/hooks/useBuy";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useCollateralFactors, type PositionData } from "@/hooks/usePosition";
import { CASH } from "@/config/risk";
import { monthlyCost } from "@/lib/aave/math";
import { maxSpendRaw, toUsd } from "@/lib/cash";
import { CREDIT_BLOCKED, backingOptions, planCredit, splitCash, type CreditPlan } from "@/lib/creditBuy";
import { formatShares, formatUsd, inWords, monthlyCostText } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { STATUS_LABEL } from "@/lib/risk/status";
import { BUY_LIMITS, minOut, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Step = "market" | "amount";
const ORDER: Step[] = ["market", "amount"];

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * Flow 1: Market (F1-3) → the stock's sheet → Buy (F1-4), then Home with the "Bought …" toast (F1-6). A Market row
 * opens the stock's sheet (StockSheets), whose Buy opens this sheet again at the Buy step. There is no confirm step of
 * ours: the Buy step says what you get, what moves and the fee, and its button opens JAW's own sheet (its Review and
 * Face ID). More than your cash (decision 1): "That's more than your cash" and one button that takes credit for the
 * other part, in one batch: withdraw savings, take credit, approve, swap. ("Use credit for buying", the Credit sheet's
 * switch, went with that sheet, Adrian 2026-10-15: credit is always offered for the other part.)
 */
export function BuySheet({
  open, user, data, symbol: initial, onClose, onStock, onBack,
}: {
  open: boolean;
  user: `0x${string}`;
  data: PositionData;
  /** Open at this stock's Buy step (resolved through the registry only); the Market list otherwise. */
  symbol: string | null;
  onClose: () => void;
  /** A Market row: open that stock's sheet. */
  onStock: (symbol: string) => void;
  /** Opened from the stock's sheet: Back on the Buy step returns there. The Market otherwise. */
  onBack?: () => void;
}) {
  const { isConnected } = useAccount();
  const symbol = EQUITIES.find((e) => e.symbol === initial)?.symbol ?? null;
  const [step, setStep] = useState<Step>(symbol ? "amount" : "market");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [raw, setRaw] = useState("");
  const [ack, setAck] = useState(false);
  const go = (next: Step) => {
    setDirection(ORDER.indexOf(next) > ORDER.indexOf(step) ? "forward" : "back");
    setStep(next);
  };

  const stock = EQUITIES.find((e) => e.symbol === symbol);
  const holding = data.holdings.find((h) => h.symbol === symbol);
  const oraclePriceUsd = holding?.priceUsd ?? 0;
  const amount = Math.max(0, Number(raw.replace(/[^0-9.]/g, "")) || 0);
  const quote = useBuyQuote(stock, step === "market" ? 0 : amount);
  const fee = useFeeSupport();
  const cfs = useCollateralFactors(data.holdings);

  const q = quote.data ?? null;
  const econ = q && stock ? quoteEconomics(q, stock, oraclePriceUsd) : null;
  const { cash, cashUsd } = data;
  const maxUsd = toUsd(maxSpendRaw(cash));
  const closed = !marketState().open;

  // Decision 1: past your cash, cash pays what it can and credit the other part.
  const over = amount > cashUsd;
  const split = over ? splitCash(q?.amountIn ?? parseUnits(amount.toFixed(USDC.decimals), USDC.decimals), cash) : null;
  const plan =
    split && cfs ? planCredit({ position: data, options: backingOptions(data.holdings, cfs), creditRaw: split.creditRaw, cash }) : null;
  const creditUsd = split ? toUsd(split.creditRaw) : 0;

  let blocker: string | null = null;
  if (amount > 0 && amount < BUY_LIMITS.minUsd) blocker = `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`;
  else if (!over && amount > maxUsd) blocker = `Leave ${formatUsd(CASH.feeBufferUsd)} for the network fee.`;
  else if (stock && amount > 0 && quote.isSuccess && q === null) blocker = `There’s no market for ${stock.name} right now.`;
  else if (econ && econ.premium > BUY_LIMITS.blockPremium)
    blocker = `Too big for the market right now: you’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. Try a smaller amount.`;
  else if (plan?.block) blocker = CREDIT_BLOCKED[plan.block];
  const warnPremium = !!econ && econ.premium > BUY_LIMITS.warnPremium && !blocker;
  const feeBlocked = isConnected && fee.state === "unsupported";
  // Past your cash, it can go ahead only with its credit plan: never a cash buy for more than the cash.
  const ready = amount > 0 && !!q && !!econ && !blocker && !quote.isFetching && (!over || !!plan);
  // What the button would sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
  const signable =
    open && ready && stock && q && !feeBlocked && !(plan?.extraConfirm && !ack)
      ? { user, stock, quote: q, credit: plan ? { plan, confirmedRisk: ack } : undefined }
      : null;
  const { sign: signBuy, phase, error, reset, busy, txHash, checking, blocked } = useBuy(signable);
  // Once the batch lands: Home, with "Bought 0.1120 NVDA" read from the receipt (F1-6).
  useBoughtHome({ phase, user, symbol: symbol ?? "", txHash, credit: !!plan, onClose });
  const note =
    blocker ??
    (warnPremium && stock
      ? `You’d pay ${(econ!.premium * 100).toFixed(1)}% over Aave’s price — the market for ${stock.name} is small.`
      : closed
        ? "Stock markets are closed. You can still buy, but the price can jump when they reopen."
        : null);

  const back = () => {
    if (busy) onClose();
    else if (onBack) onBack();
    else go("market");
  };

  // F1-3: every stock in one list, A to Z, the ones you own marked "You own $X".
  const stocks = [...data.holdings].sort(byName);
  const sign = () => {
    if (!signable) return;
    if (phase === "failed") reset();
    void signBuy();
  };
  const disabled = !signable || fee.loading || blocked || phase === "done";

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={step === "market" || !stock ? "Market" : `Buy ${stock.name}`}
      description={step === "market" ? "Pick one to buy." : undefined}
      topPx={step === "market" ? 188 : undefined}
      onBack={step === "market" ? undefined : back}
    >
      <SheetSteps stepKey={step} direction={direction} className="flex flex-col gap-3">
        {step === "market" || !stock ? (
          <MarketList>
            {stocks.map((h) => (
              <MarketRow
                key={h.symbol}
                symbol={h.symbol}
                name={h.name}
                priceUsd={h.priceUsd}
                ownedUsd={h.freeRaw + h.lockedRaw > 0n ? h.freeUsd + h.lockedUsd : 0}
                onClick={() => onStock(h.symbol)}
              />
            ))}
          </MarketList>
        ) : (
          <>
            <AmountField
              label="You pay"
              source={<AmountSource>Cash</AmountSource>}
              badge={<AmountBadge kind="cash" />}
              value={raw}
              onValue={(v) => {
                setRaw(v);
                // The risk tick is for the plan on screen; a new amount asks again.
                setAck(false);
              }}
              autoFocus
              onMax={() => {
                setRaw((Math.floor(maxUsd * 100) / 100).toString());
                setAck(false);
              }}
              hint={`Cash available: ${formatUsd(cashUsd)}`}
            />
            <AmountArrow />
            <YouGet symbol={stock.symbol} shares={quote.isFetching && amount > 0 ? null : econ ? econ.shares : 0} priceUsd={econ ? econ.price : oraclePriceUsd} />
            <Summary rows={plan && split ? creditRows(data, plan, split.cashRaw) : [{ label: "Arrives", value: "In seconds" }, NETWORK_FEE_ROW]} />
            {note && (
              <p role="status" className={`m-0 text-[13px] leading-snug ${blocker ? "text-act" : "text-watch-text"}`}>{note}</p>
            )}
            {ready && q && econ && (
              <SmallPrint
                data={data}
                stock={stock}
                econ={econ}
                minShares={Number(minOut(q.amountOut)) / 10 ** stock.decimals}
                venue={VENUE_LABEL[q.venue]}
                credit={plan && split ? { plan, cashRaw: split.cashRaw } : null}
              />
            )}
            {ready && plan?.extraConfirm && (
              <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
                I understand this puts my credit in {STATUS_LABEL[plan.after]}. If my stocks fall too far, part of them can be sold to repay what I owe.
              </label>
            )}
            {feeBlocked && (
              <p role="alert" className="m-0 text-[13px] text-act">
                Your account can’t pay network fees in USDC on Base right now, so this buy can’t go through.
              </p>
            )}
            <TxError error={error} />
            {over ? (
              <>
                <Button variant="dark" disabled className="mt-1">That’s more than your cash ({formatUsd(cashUsd)})</Button>
                {!blocker && (
                  <TxButton label={`Use credit for the other ${formatUsd(creditUsd)}`} size="md" phase={phase} checking={checking} preview={!isConnected} disabled={disabled} onClick={sign} />
                )}
              </>
            ) : (
              <div className="mt-1">
                <TxButton label="Buy" size="md" phase={phase} checking={checking} preview={!isConnected} disabled={disabled} onClick={sign} />
              </div>
            )}
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

/** Decision 1's facts, in the amount step's box: what cash and credit each pay, the cost and the status after. */
function creditRows(data: PositionData, plan: CreditPlan, cashRaw: bigint): SummaryRow[] {
  const creditUsd = toUsd(plan.creditRaw);
  const backers = plan.backing.length ? plan.backing.map((b) => b.stock.name) : data.holdings.filter((h) => h.lockedRaw > 0n).map((h) => h.name);
  return [
    { label: "From your cash", value: formatUsd(toUsd(cashRaw)) },
    { label: "On credit", value: formatUsd(creditUsd) },
    { label: "Backed by", value: backers.length > 2 ? `${backers.length} of your stocks` : inWords(backers) },
    { label: "Cost", value: `${(data.apr * 100).toFixed(1)}% a year · ${monthlyCostText(monthlyCost(creditUsd, data.apr))}` },
    { label: "You owe after", value: formatUsd(data.debtUsd + creditUsd) },
    // No debt yet is as safe as it gets: the board reads "Safe → Safe" for a first Credit Buy.
    { label: "Status", value: <StatusChange from={plan.before === "none" ? "safe" : plan.before} to={plan.after} /> },
    NETWORK_FEE_ROW,
  ];
}

/** The small print under the Buy step (and the Trade sheet's cash → stock): every move in the batch (D7), the price guard, and what the stock is. */
export function SmallPrint({
  data, stock, econ, minShares, venue, credit,
}: {
  data: PositionData;
  stock: ReserveAsset;
  econ: ReturnType<typeof quoteEconomics>;
  minShares: number;
  venue: string;
  /** Decision 1: the credit plan for the part cash can't pay, and what cash pays. */
  credit: { plan: CreditPlan; cashRaw: bigint } | null;
}) {
  const ticker = tickerOf(stock.symbol);
  const plan = credit?.plan;
  const moves = [
    ...(plan?.backing ?? []).map((b) => {
      const h = data.holdings.find((x) => x.symbol === b.stock.symbol);
      return `${formatShares(rawToShares(b.raw, h?.multiplier ?? 10n ** 18n, b.stock.decimals))} ${tickerOf(b.stock.symbol)} goes in use to back credit`;
    }),
    ...(plan ? [`${formatUsd(toUsd(plan.creditRaw))} of credit is taken`] : []),
    `exactly ${formatUsd(econ.usd)} is approved for the ${venue} router and swapped`,
  ];
  return (
    <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
      In one go: {inWords(moves)}. You get at least {minShares.toFixed(4)} {ticker}: if the price moves more than{" "}
      {BUY_LIMITS.slippageBps / 100}%, the buy is cancelled.{" "}
      {plan && `Credit costs ${(data.apr * 100).toFixed(2)}% a year (variable). If your stocks fall too far, part of them can be sold to repay what you owe. `}
      {stock.name} here is a tokenized stock. It tracks the share price; it is not company shares or voting rights.
    </p>
  );
}

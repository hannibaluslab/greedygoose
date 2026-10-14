"use client";

import { useState, type ReactNode } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountArrow, AmountBadge, AmountField, AmountSource, YouGet } from "./AmountField";
import { Button } from "./Button";
import { MarketList, MarketRow } from "./Market";
import { StatusChange } from "./Status";
import { tickerOf } from "./StockAvatar";
import { NETWORK_FEE_ROW, Summary, type SummaryRow } from "./Summary";
import { FaceIdButton, TxError } from "./TxUi";
import { CreditIcon } from "./icons";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuy } from "@/hooks/useBuy";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useCollateralFactors, type PositionData } from "@/hooks/usePosition";
import { CASH } from "@/config/risk";
import { monthlyCost } from "@/lib/aave/math";
import { maxSpendRaw, savingsWithdrawal, toUsd } from "@/lib/cash";
import { CREDIT_BLOCKED, backingOptions, planCredit, splitCash, type CreditPlan } from "@/lib/creditBuy";
import { formatShares, formatUsd } from "@/lib/formatting";
import { marketState } from "@/lib/market-hours";
import { STATUS_LABEL } from "@/lib/risk/status";
import { BUY_LIMITS, minOut, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Step = "market" | "amount" | "review";
const ORDER: Step[] = ["market", "amount", "review"];

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
/** "a", "a and b", "a, b and c". */
const inWords = (parts: string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/**
 * Flow 1 in one drawer: Market (F1-3, PortfolioMarket) → Buy (F1-4) → Confirm (F2-6's layout; there is no
 * F1-5 board), then Home with the "Bought …" toast (F1-6). More than your cash (decision 1): Review is
 * blocked and one button takes credit for the other part, so the review becomes one batch: withdraw
 * savings, take credit, approve, swap.
 */
export function BuySheet({
  open, user, data, symbol: initial, onClose,
}: {
  open: boolean;
  user: `0x${string}`;
  data: PositionData;
  /** Open at this stock's Buy step (resolved through the registry only); the Market list otherwise. */
  symbol: string | null;
  onClose: () => void;
}) {
  const { isConnected } = useAccount();
  const [symbol, setSymbol] = useState(() => EQUITIES.find((e) => e.symbol === initial)?.symbol ?? null);
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
  const { buy, phase, error, reset, busy, txHash } = useBuy();

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
  // Once the batch lands: Home, with "Bought 0.1120 NVDA" read from the receipt (F1-6).
  useBoughtHome({ phase, user, symbol: symbol ?? "", txHash, credit: !!plan, onClose });

  let blocker: string | null = null;
  if (amount > 0 && amount < BUY_LIMITS.minUsd) blocker = `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`;
  else if (!over && amount > maxUsd) blocker = `Leave ${formatUsd(CASH.feeBufferUsd)} for the network fee.`;
  else if (stock && amount > 0 && quote.isSuccess && q === null) blocker = `There’s no market for ${stock.name} right now.`;
  else if (econ && econ.premium > BUY_LIMITS.blockPremium)
    blocker = `Too big for the market right now: you’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. Try a smaller amount.`;
  else if (plan?.block) blocker = CREDIT_BLOCKED[plan.block];
  const warnPremium = !!econ && econ.premium > BUY_LIMITS.warnPremium && !blocker;
  const feeBlocked = isConnected && fee.state === "unsupported";
  const ready = amount > 0 && !!q && !blocker && !quote.isFetching && (!over || !!plan);
  const note =
    blocker ??
    (warnPremium && stock
      ? `You’d pay ${(econ!.premium * 100).toFixed(1)}% over Aave’s price — the market for ${stock.name} is small.`
      : closed
        ? "Stock markets are closed. You can still buy, but the price can jump when they reopen."
        : null);

  const pick = (next: string) => {
    if (next !== symbol) setRaw("");
    setSymbol(next);
    go("amount");
  };
  const back = () => {
    if (step === "amount") go("market");
    else if (busy) onClose();
    else {
      if (phase === "failed") reset();
      setAck(false);
      go("amount");
    }
  };

  const held = data.holdings.filter((h) => h.freeRaw + h.lockedRaw > 0n).sort(byName);
  const others = data.holdings.filter((h) => h.freeRaw + h.lockedRaw === 0n).sort(byName);

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={step === "market" || !stock ? "Market" : step === "amount" ? `Buy ${stock.name}` : "Confirm"}
      description={step === "market" ? "Pick one to buy." : undefined}
      topPx={step === "market" ? 188 : undefined}
      onBack={step === "market" ? undefined : back}
    >
      <SheetSteps stepKey={step} direction={direction} className="flex flex-col gap-3">
        {step === "market" || !stock ? (
          <MarketList>
            {[...held, ...others].map((h) => (
              <MarketRow
                key={h.symbol}
                symbol={h.symbol}
                name={h.name}
                priceUsd={h.priceUsd}
                ownedUsd={h.freeRaw + h.lockedRaw > 0n ? h.freeUsd + h.lockedUsd : 0}
                onClick={() => pick(h.symbol)}
              />
            ))}
          </MarketList>
        ) : step === "amount" ? (
          <>
            <AmountField
              label="You pay"
              source={<AmountSource>Cash</AmountSource>}
              badge={<AmountBadge kind="cash" />}
              value={raw}
              onValue={setRaw}
              autoFocus
              onMax={() => setRaw((Math.floor(maxUsd * 100) / 100).toString())}
              hint={`Cash available: ${formatUsd(cashUsd)}`}
            />
            <AmountArrow />
            <YouGet symbol={stock.symbol} shares={quote.isFetching && amount > 0 ? null : econ ? econ.shares : 0} priceUsd={econ ? econ.price : oraclePriceUsd} />
            <Summary look="box" rows={[{ label: "Arrives", value: "In seconds" }, NETWORK_FEE_ROW]} />
            {note && (
              <p role="status" className={`m-0 text-[13px] leading-snug ${blocker ? "text-act" : "text-watch-text"}`}>{note}</p>
            )}
            {over ? (
              <>
                <Button variant="dark" disabled className="mt-1">That’s more than your cash ({formatUsd(cashUsd)})</Button>
                {!blocker && (
                  <Button icon={<CreditIcon size={18} strokeWidth={1.8} />} disabled={!ready} onClick={() => go("review")}>
                    Use credit for the other {formatUsd(creditUsd)}
                  </Button>
                )}
              </>
            ) : (
              <Button variant="dark" disabled={!ready} onClick={() => go("review")} className="mt-1">Review buy</Button>
            )}
          </>
        ) : (
          q &&
          econ &&
          // Past your cash, the review exists only with its credit plan: never a cash review for more than the cash.
          (!over || plan) && (
            <Review
              data={data}
              stock={stock}
              econ={econ}
              amountInRaw={q.amountIn}
              minShares={Number(minOut(q.amountOut)) / 10 ** stock.decimals}
              venue={VENUE_LABEL[q.venue]}
              credit={plan && split ? { plan, cashRaw: split.cashRaw } : null}
              note={note}
              blocked={!!blocker}
              ack={ack}
              onAck={setAck}
              feeBlocked={feeBlocked}
              error={error}
              onBack={back}
              button={
                <FaceIdButton
                  label="Confirm with Face ID"
                  size="md"
                  phase={phase}
                  preview={!isConnected}
                  disabled={!!blocker || (over && !plan) || (!!plan?.extraConfirm && !ack) || feeBlocked || fee.loading || phase === "done"}
                  onClick={() => {
                    if (phase === "failed") reset();
                    void buy({ user, stock, quote: q, cash, credit: plan ? { plan, confirmedRisk: ack } : undefined });
                  }}
                />
              }
              busy={busy}
            />
          )
        )}
      </SheetSteps>
    </SheetShell>
  );
}

/**
 * The confirm step, in F2-6's layout: "$20.00 → 0.1120 NVDA", the summary table, the small print that
 * lists every move in the batch (D7), then Back and Face ID.
 */
function Review({
  data, stock, econ, amountInRaw, minShares, venue, credit, note, blocked, ack, onAck, feeBlocked, error, onBack, button, busy,
}: {
  data: PositionData;
  stock: ReserveAsset;
  econ: ReturnType<typeof quoteEconomics>;
  amountInRaw: bigint;
  minShares: number;
  venue: string;
  /** Decision 1: the credit plan for the part cash can't pay, and what cash pays. */
  credit: { plan: CreditPlan; cashRaw: bigint } | null;
  note: string | null;
  blocked: boolean;
  ack: boolean;
  onAck: (ack: boolean) => void;
  feeBlocked: boolean;
  error: string | null;
  onBack: () => void;
  button: ReactNode;
  busy: boolean;
}) {
  const ticker = tickerOf(stock.symbol);
  const fromSavings = savingsWithdrawal(credit ? credit.cashRaw : amountInRaw, data.cash);
  const plan = credit?.plan;
  const creditUsd = plan ? toUsd(plan.creditRaw) : 0;
  const backers = plan
    ? plan.backing.length
      ? plan.backing.map((b) => b.stock.name)
      : data.holdings.filter((h) => h.lockedRaw > 0n).map((h) => h.name)
    : [];

  const rows: SummaryRow[] = credit
    ? [
        { label: "From your cash", value: formatUsd(toUsd(credit.cashRaw)) },
        { label: "On credit", value: formatUsd(creditUsd) },
        { label: "Backed by", value: backers.length > 2 ? `${backers.length} of your stocks` : inWords(backers) },
        { label: "Cost", value: `${formatUsd(monthlyCost(creditUsd, data.apr))} / month` },
        { label: "You owe after", value: formatUsd(data.debtUsd + creditUsd) },
        // No debt yet is as safe as it gets: the board reads "Safe → Safe" for a first Credit Buy.
        { label: "Status", value: <StatusChange from={credit.plan.before === "none" ? "safe" : credit.plan.before} to={credit.plan.after} /> },
        NETWORK_FEE_ROW,
      ]
    : [
        { label: "You pay", value: formatUsd(econ.usd) },
        { label: "Price", value: formatUsd(econ.price) },
        { label: "You get at least", value: `${minShares.toFixed(4)} ${ticker}` },
        { label: "Via", value: venue },
        NETWORK_FEE_ROW,
      ];

  const moves = [
    ...(fromSavings ? [`${formatUsd(toUsd(fromSavings.raw))} comes out of savings`] : []),
    ...(plan?.backing ?? []).map((b) => {
      const h = data.holdings.find((x) => x.symbol === b.stock.symbol);
      return `${formatShares(rawToShares(b.raw, h?.multiplier ?? 10n ** 18n, b.stock.decimals))} ${tickerOf(b.stock.symbol)} goes in use to back credit`;
    }),
    ...(plan ? [`${formatUsd(creditUsd)} of credit is taken`] : []),
    `exactly ${formatUsd(econ.usd)} is approved for the ${venue} router and swapped`,
  ];

  return (
    <>
      <div className="pb-0.5 pt-1.5 text-center leading-[normal]">
        <div className="num text-[25px] font-semibold tracking-[-0.03em]">
          {formatUsd(econ.usd)} <span className="font-[system-ui]">→</span> {econ.shares.toFixed(4)} {ticker}
        </div>
        <div className="mt-1 text-[13px] text-ink-mid">{stock.name}, with your {plan ? "cash and credit" : "cash"}</div>
      </div>
      <Summary rows={rows} />
      <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
        In one Face ID: {inWords(moves)}. If the price moves more than {BUY_LIMITS.slippageBps / 100}%, the buy is cancelled.{" "}
        {plan && `Credit costs ${(data.apr * 100).toFixed(2)}% a year (variable). If your stocks fall too far, Aave can sell part of them to repay what you owe. `}
        {stock.name} here is a tokenized stock. It tracks the share price; it is not company shares or voting rights.
      </p>
      {note && <p role="status" className={`m-0 text-[13px] leading-snug ${blocked ? "text-act" : "text-watch-text"}`}>{note}</p>}
      {plan?.extraConfirm && (
        <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
          <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
          I understand this puts my credit in {STATUS_LABEL[plan.after]}. If my stocks fall, Aave can sell part of them.
        </label>
      )}
      {feeBlocked && (
        <p role="alert" className="m-0 text-[13px] text-act">
          Your account can’t pay network fees in USDC on Base right now, so this buy can’t go through.
        </p>
      )}
      <TxError error={error} />
      <div className="mt-1 flex items-start gap-2">
        <Button variant="soft" onClick={onBack} disabled={busy}>Back</Button>
        <div className="flex-1">{button}</div>
      </div>
    </>
  );
}

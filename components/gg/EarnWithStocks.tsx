"use client";

import { useState, type ReactNode } from "react";
import { parseUnits } from "viem";
import { AmountBadge, AmountField, AmountSource } from "./AmountField";
import { Button } from "./Button";
import { StatusChange } from "./Status";
import { StockAvatar } from "./StockAvatar";
import { NETWORK_FEE_ROW, Summary } from "./Summary";
import { TxButton, TxError } from "./TxUi";
import type { TxPhase } from "@/hooks/useTx";
import { useEarnRates } from "@/hooks/useEarnWithStocks";
import type { PositionData } from "@/hooks/usePosition";
import { LIMIT_USD, testCapNote } from "@/lib/agents/permissions";
import type { AgentStatus } from "@/lib/agents/status";
import { backers, type BackingOption } from "@/lib/creditBuy";
import {
  earnBlock,
  earnHint,
  earnQuote,
  earnRiskLine,
  earnSmallPrint,
  earnTick,
  pctText,
  type EarnOffer,
  type EarnOpen,
  type EarnQuote,
  type EarnRates,
} from "@/lib/earnWithStocks";
import { aprToApy } from "@/lib/aave/math";
import { formatUsdTrim } from "@/lib/formatting";
import { homeStatus } from "@/lib/risk/status";
import { rawToShares } from "@/lib/tokens/b20";
import { USDC } from "@/lib/tokens/registry";

const CARD = "flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-card-elev";
const MONO = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle";

/** The rates side by side: what the cash earns, what credit costs, and (when it's offered) what's left. */
function Rates({ rates, left }: { rates: EarnRates; left: boolean }) {
  const cell = (label: string, value: ReactNode) => (
    <div className="flex min-w-0 flex-col justify-between gap-1">
      <dt className={MONO}>{label}</dt>
      <dd className="m-0 whitespace-nowrap text-[20px] font-semibold leading-[1.1] tracking-[-0.02em]">{value}</dd>
    </div>
  );
  return (
    // What's left sizes to "about 1.9%" so it never wraps at 320px; the two rates share the rest.
    <dl className={`m-0 grid gap-2 ${left ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" : "grid-cols-2"}`}>
      {cell("Your cash earns", pctText(rates.earn))}
      {cell("This credit costs", pctText(rates.cost))}
      {left &&
        cell(
          "What’s left",
          <>
            <span className="text-[13px] font-medium text-subtle">about </span>
            {pctText(rates.left)}
          </>,
        )}
    </dl>
  );
}

/**
 * "Earn with stocks" on the Cash sheet's first step: the live rates side by side and one button to the earn step, or
 * one plain line on why it's not offered now. Hidden with no executor (no earning to put credit to).
 */
export function EarnCard({ offer, onOpen }: { offer: EarnOffer; onOpen: () => void }) {
  if (offer.kind === "hidden") return null;
  if (offer.kind === "loading")
    return (
      <div aria-busy className="h-16 animate-pulse rounded-[22px] bg-chip">
        <span className="sr-only">Loading Earn with stocks</span>
      </div>
    );
  return (
    <section aria-label="Earn with stocks" className={CARD}>
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-[15px] font-semibold">Earn with stocks</h3>
        <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">
          {offer.kind === "offer" ? "Use your stocks to add cash that earns." : offer.text}
        </p>
      </div>
      {offer.kind === "offer" ? (
        <>
          <Rates rates={offer.rates} left />
          <p className="m-0 -mt-1 text-[12.5px] leading-[1.4] text-subtle">A year, at today’s rates. Both are variable.</p>
          <Button variant="dark" onClick={onOpen}>Earn with stocks</Button>
        </>
      ) : (
        offer.rates && <Rates rates={offer.rates} left={false} />
      )}
    </section>
  );
}

/**
 * The earn step: how much credit comes to the cash, what it earns and costs at that amount (the cost is this credit's
 * own, from the rate after the batch), the status before and after, the risk tick (D2), every move in small print (D7),
 * then one button that opens JAW's sheet. No confirm screen of ours.
 */
export function EarnStep({
  user, data, offer, options, protect, sell, capMaxRaw, phase, error, preview, feeBlocked, onEarn, initialAmount = "", fixedApyAfter,
}: {
  user: `0x${string}`;
  data: PositionData;
  offer: EarnOpen;
  options: BackingOption[];
  protect: AgentStatus;
  sell: AgentStatus;
  capMaxRaw: bigint | null;
  phase: TxPhase;
  error: string | null;
  preview: boolean;
  /** Why the network fee can't be paid (D4), or null. */
  feeBlocked: string | null;
  onEarn: (quote: EarnQuote, confirmedRisk: boolean) => void;
  /** Dev gallery: an amount already typed, and the credit's rate after it instead of reading it from a simulation. */
  initialAmount?: string;
  fixedApyAfter?: number;
}) {
  const [raw, setRaw] = useState(initialAmount);
  const [ack, setAck] = useState(false);
  const amount = Math.max(0, Number(raw) || 0);
  const creditRaw = parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
  const apyNow = aprToApy(data.apr);

  // The plan first, for the batch the rate after it is read from.
  const draft = earnQuote({ offer, position: data, options, cash: data.cash, creditRaw, creditApyNow: apyNow, creditApyAfter: null });
  const read = useEarnRates({ user, backing: draft.plan.backing, creditRaw, apyNow, enabled: fixedApyAfter === undefined });
  const apyAfter = fixedApyAfter ?? read.apyAfter;
  const quote = apyAfter === null ? draft : earnQuote({ offer, position: data, options, cash: data.cash, creditRaw, creditApyNow: apyNow, creditApyAfter: apyAfter });
  const { plan } = quote;

  const block = amount > 0 ? earnBlock(quote, offer) : null;
  const ready = amount > 0 && !block && quote.left !== null;
  const tick = ready && plan.extraConfirm;

  // D2's tick is for the status it names: a price refresh that moves the result (Watch to Act) asks again.
  const [tickedFor, setTickedFor] = useState(plan.after);
  if (tickedFor !== plan.after) {
    setTickedFor(plan.after);
    setAck(false);
  }

  // What backs it: what the plan puts in use and what's in use already, the stock picked first.
  const lead = plan.backing[0]?.stock.symbol ?? [...options].sort((a, b) => b.cf - a.cf)[0]?.stock.symbol;
  const adding = plan.backing.length ? plan.backing.map((b) => b.stock.symbol) : data.collateralUsd > 0 || !lead ? [] : [lead];
  const backedBy = backers(data.holdings, adding, lead);

  const cap = offer.limitedBy === "today" ? testCapNote(LIMIT_USD.save.start, capMaxRaw) : null;
  const hint = [earnHint(offer), cap].filter(Boolean).join(" ");

  const cost = amount > 0 ? quote.cost : offer.rates.cost;
  const left = amount > 0 ? quote.left : offer.rates.left;
  const leftText =
    left === null
      ? "…"
      : amount > 0 && quote.leftUsdYear !== null
        ? `about ${pctText(left)} · ${quote.leftUsdYear >= 1 ? formatUsdTrim(quote.leftUsdYear) : "under $1"} a year`
        : `about ${pctText(left)} a year`;

  const backingShares = plan.backing.map((b) => {
    const h = data.holdings.find((x) => x.symbol === b.stock.symbol)!;
    return { symbol: b.stock.symbol, shares: rawToShares(b.raw, h.multiplier, b.stock.decimals) };
  });

  return (
    <>
      <AmountField
        label="Add to your cash"
        source={
          backedBy.length > 0 && (
            <AmountSource mark={<StockAvatar symbol={backedBy[0].symbol} size={16} />}>
              Backed by {backedBy[0].name}
              {backedBy.length > 1 ? ` +${backedBy.length - 1}` : ""}
            </AmountSource>
          )
        }
        badge={<AmountBadge kind="credit" />}
        value={raw}
        onValue={(v) => {
          setRaw(v);
          setAck(false);
        }}
        onMax={() => {
          setRaw(String(Math.floor(offer.maxUsd)));
          setAck(false);
        }}
        hint={hint}
        autoFocus
      />
      <Summary
        rows={[
          { label: "Your cash earns", value: `${pctText(offer.rates.earn)} a year` },
          { label: "This credit costs", value: cost === null ? "…" : `${pctText(cost)} a year` },
          { label: "What’s left", value: leftText },
          { label: "Status", value: <StatusChange from={homeStatus(plan.before)} to={homeStatus(plan.after)} /> },
          NETWORK_FEE_ROW,
        ]}
      />
      <p className="m-0 px-0.5 text-[12.5px] leading-[1.45] text-subtle">Both rates are variable. Your cash starts earning on this soon.</p>
      {(block || plan.priceMayMove) && (
        <p role="status" className={`m-0 text-[13px] leading-snug ${block ? "text-act" : "text-watch-text"}`}>
          {block ?? "Stock markets are closed. You can still do this, but prices can jump when they reopen."}
        </p>
      )}
      {ready && (
        <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
          {earnSmallPrint({
            backing: backingShares,
            amountUsd: amount,
            owedUsd: data.debtUsd + amount,
            backedBy: backedBy.map((h) => h.name),
            risk: earnRiskLine({ names: backedBy.map((h) => h.name), protect, sell }),
          })}
        </p>
      )}
      {tick && (
        <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
          {earnTick(plan.after)}
        </label>
      )}
      {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">{feeBlocked}</p>}
      <TxError error={error} />
      <div className="mt-1">
        <TxButton
          label="Earn with stocks"
          size="md"
          phase={phase}
          preview={preview}
          disabled={!ready || (tick && !ack) || !!feeBlocked || phase === "done"}
          onClick={() => onEarn(quote, ack)}
        />
      </div>
    </>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { parseUnits } from "viem";
import { AmountBadge, AmountField, AmountSource } from "../kit/AmountField";
import { Button } from "../kit/Button";
import { StatusChange } from "../Status";
import { StockAvatar } from "../kit/StockAvatar";
import { Summary } from "../home/Summary";
import { TxButton, TxError } from "../TxUi";
import { usePrepare, type TxPhase, type TxPlan, type TxPrep } from "@/hooks/useTx";
import { useEarnRates } from "@/hooks/useEarnWithStocks";
import type { EarnInput } from "@/lib/tx/plans";
import type { PositionData } from "@/hooks/usePosition";
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
  type UsedFor,
  offerFor,
} from "@/lib/earnWithStocks";
import { aprToApy } from "@/lib/aave/math";
import { formatShares, formatUsd, formatUsdTrim } from "@/lib/formatting";
import { homeStatus } from "@/lib/risk/status";
import { backingShares } from "@/lib/holding";
import { USDC } from "@/lib/tokens/registry";

const CARD = "flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-card-elev";
const MONO = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle";

/**
 * The rates side by side: what the cash earns, what credit costs, and (when it's offered) what's left. `cost` names the
 * credit's column: "Credit costs" once it's earning, short enough not to wrap at 375px.
 */
function Rates({ rates, left, cost = "This credit costs" }: { rates: EarnRates; left: boolean; cost?: string }) {
  const cell = (label: string, value: ReactNode) => (
    <div className="flex min-w-0 flex-col justify-between gap-1">
      <dt className={MONO}>{label}</dt>
      <dd className="m-0 whitespace-nowrap text-[20px] font-semibold leading-[1.1] tracking-[-0.02em]">{value}</dd>
    </div>
  );
  return (
    // What's left sizes to "about 1.9%" so it never wraps at 320px; the two rates share the rest.
    <dl className={`m-0 grid gap-2 ${left ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" : "grid-cols-2"}`}>
      {cell("My cash earns", pctText(rates.earn))}
      {cell(cost, pctText(rates.cost))}
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
 * one plain line on why it's not offered now. It needs no agent: the batch puts the credit where the cash earns. Once
 * some of the cash came from credit (`earning`), it says how much, what the cash earns and the credit costs right now
 * (`rates`, live, whether or not more can be added), each stock's share in it ("Used for this", usedForEarning), and
 * Stop earning with stocks: Repay opens with that cash to repay and those stocks ticked to free up.
 */
export function EarnCard({
  offer,
  onOpen,
  earning,
}: {
  offer: EarnOffer;
  onOpen: () => void;
  earning?: { usd: number; rates: EarnRates; used: UsedFor[]; onStop: () => void } | null;
}) {
  if (offer.kind === "loading" && !earning)
    return (
      <div aria-busy className="h-16 animate-pulse rounded-[22px] bg-chip">
        <span className="sr-only">Loading Earn with stocks</span>
      </div>
    );
  // Earning already: "can't back more credit" is no news, the earning line says what matters.
  const line =
    offer.kind === "offer"
      ? earning
        ? null
        : "Use your stocks to add cash that earns."
      : offer.kind === "closed" && !(earning && offer.why === "credit")
        ? offer.text
        : null;
  return (
    <section aria-label="Earn with stocks" className={CARD}>
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-[15px] font-semibold">Earn with stocks</h3>
        {earning && (
          <p className="m-0 text-[14px] leading-[1.4] text-ink">
            <span className="font-semibold">{formatUsd(earning.usd)}</span> from credit is earning
          </p>
        )}
        {line && <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">{line}</p>}
      </div>
      {earning ? (
        <>
          <Rates rates={earning.rates} left cost="Credit costs" />
          <p className="m-0 -mt-1 text-[12.5px] leading-[1.4] text-subtle">Live yearly rates. Both vary.</p>
          {earning.used.length > 0 && <UsedForThis used={earning.used} />}
        </>
      ) : (
        offer.kind === "offer" && (
          <>
            <Rates rates={offer.rates} left />
            <p className="m-0 -mt-1 text-[12.5px] leading-[1.4] text-subtle">
              A year, at today’s rates. Both are variable.
            </p>
          </>
        )
      )}
      {offer.kind === "offer" ? (
        <Button variant="soft" onClick={onOpen}>
          {earning ? "Add more" : "Earn with stocks"}
        </Button>
      ) : (
        !earning && offer.kind === "closed" && offer.rates && <Rates rates={offer.rates} left={false} />
      )}
      {earning && (
        <Button variant="soft" onClick={earning.onStop}>
          Stop earning with stocks
        </Button>
      )}
    </section>
  );
}

/** "Used for this": each stock's share in the credit that's earning, its shares with their value beside them. */
function UsedForThis({ used }: { used: UsedFor[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={MONO}>Used for this</span>
      <dl className="m-0 flex flex-col gap-1">
        {used.map((u) => (
          <div key={u.symbol} className="flex items-baseline justify-between gap-3 text-[14px]">
            <dt className="min-w-0 truncate text-ink">{u.name}</dt>
            <dd className="num m-0 whitespace-nowrap text-ink-2">
              {formatShares(u.shares)} ({formatUsd(u.usd)})
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The earn step: how much credit comes to the cash, what it earns and costs at that amount (the cost is this credit's
 * own, from the rate after the batch), the status before and after, the risk tick (D2), every move in small print (D7),
 * then one button that opens JAW's sheet. No confirm screen of ours. The same batch puts the credit where the cash
 * earns, so it earns at once.
 */
export function EarnStep({
  user,
  data,
  offer,
  options,
  protect,
  sell,
  phase,
  error,
  preview,
  feeBlocked,
  prep,
  planFor,
  onEarn,
  initialAmount = "",
  fixedApyAfter,
}: {
  user: `0x${string}`;
  data: PositionData;
  offer: EarnOpen;
  options: BackingOption[];
  protect: AgentStatus;
  sell: AgentStatus;
  phase: TxPhase;
  error: string | null;
  preview: boolean;
  /** Why the network fee can't be paid (D4), or null. */
  feeBlocked: string | null;
  /** The write's store (useEarnWithStocks' `prep`) and its plan, so the batch on screen is prepared before the tap. */
  prep?: TxPrep;
  planFor?: (p: EarnInput) => TxPlan;
  /** The quote signed, and the offer as held to the ticked stocks (offerFor). */
  onEarn: (quote: EarnQuote, confirmedRisk: boolean, held: EarnOpen) => void;
  /** Dev gallery: an amount already typed, and the credit's rate after it instead of reading it from a simulation. */
  initialAmount?: string;
  fixedApyAfter?: number;
}) {
  const [raw, setRaw] = useState(initialAmount);
  const [ack, setAck] = useState(false);
  // The stocks that may back it: all of them to start, one tap each to leave one out (Adrian, 2026-10-19).
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const ticked = options.filter((o) => !left.has(o.stock.symbol));
  const held = offerFor(offer, { position: data, options: ticked, cash: data.cash });
  const amount = Math.max(0, Number(raw) || 0);
  const creditRaw = parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
  const quote = useEarnQuote({ user, data, offer: held, options: ticked, creditRaw, fixedApyAfter });
  const { plan } = quote;

  const block = amount > 0 ? earnBlock(quote, held) : null;
  const ready = amount > 0 && !block && quote.left !== null;
  const tick = ready && plan.extraConfirm;
  // What the button would sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
  const allowed = ready && !(tick && !ack) && !feeBlocked;
  const signable = allowed && planFor ? planFor({ user, quote, offer: held, confirmedRisk: ack }) : null;
  const prepared = usePrepare(prep, signable);

  // D2's tick is for the status it names: a price refresh that moves the result (Watch to Act) asks again.
  const [tickedFor, setTickedFor] = useState(plan.after);
  if (tickedFor !== plan.after) {
    setTickedFor(plan.after);
    setAck(false);
  }

  const backedBy = backedByOf(plan, ticked, data);
  const hint = earnHint(held);
  const cost = amount > 0 ? quote.cost : offer.rates.cost;
  const leftText = leftTextOf(amount, quote, held);

  return (
    <>
      {options.length > 1 && (
        <BackWith
          options={options}
          left={left}
          onToggle={(symbol) => {
            setLeft((l) => {
              const next = new Set(l);
              if (next.has(symbol)) next.delete(symbol);
              else next.add(symbol);
              return next;
            });
            setAck(false);
          }}
        />
      )}
      <AmountField
        label="Add to my cash"
        source={backedBy.length > 0 && <BackedBySource backedBy={backedBy} />}
        badge={<AmountBadge kind="credit" />}
        value={raw}
        onValue={(v) => {
          setRaw(v);
          setAck(false);
        }}
        onMax={() => {
          setRaw(String(Math.floor(held.maxUsd)));
          setAck(false);
        }}
        hint={hint}
        autoFocus
      />
      <Summary
        rows={[
          { label: "My cash earns", value: `${pctText(offer.rates.earn)} a year` },
          { label: "This credit costs", value: cost === null ? "…" : `${pctText(cost)} a year` },
          { label: "What’s left", value: leftText },
          { label: "Status", value: <StatusChange from={homeStatus(plan.before)} to={homeStatus(plan.after)} /> },
        ]}
      />
      <p className="m-0 px-0.5 text-[12.5px] leading-[1.45] text-subtle">
        Both rates are variable. It starts earning right away.
      </p>
      <EarnNote block={block} closed={plan.priceMayMove} />
      {ready && (
        <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
          {earnSmallPrint({
            // Every stock the batch puts in use, or a throw: a line of what's signed is never dropped.
            backing: backingShares(plan.backing, data.holdings),
            amountUsd: amount,
            owedUsd: data.debtUsd + amount,
            backedBy: backedBy.map((h) => h.name),
            risk: earnRiskLine({ names: backedBy.map((h) => h.name), protect, sell, lines: data.protect }),
          })}
        </p>
      )}
      {tick && (
        <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-px size-[18px] shrink-0 accent-neg"
          />
          {earnTick(plan)}
        </label>
      )}
      {feeBlocked && (
        <p role="alert" className="m-0 text-[13px] text-act">
          {feeBlocked}
        </p>
      )}
      <TxError error={error ?? prepared.error} />
      <div className="mt-1">
        <TxButton
          label="Earn with stocks"
          size="md"
          phase={phase}
          checking={prepared.checking}
          preview={preview}
          disabled={!allowed || prepared.blocked || phase === "done"}
          onClick={() => onEarn(quote, ack, held)}
        />
      </div>
    </>
  );
}

/**
 * "Back it with": the free stocks that may back this credit, all ticked to start; a tap leaves one out or takes it back
 * (Adrian, 2026-10-19: one, several or all). What already backs credit always counts.
 */
function BackWith({
  options,
  left,
  onToggle,
}: {
  options: BackingOption[];
  left: ReadonlySet<string>;
  onToggle: (symbol: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className={MONO}>Back it with</span>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = !left.has(o.stock.symbol);
          return (
            <button
              key={o.stock.symbol}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(o.stock.symbol)}
              className={`flex h-10 items-center gap-2 rounded-full border-[1.5px] pl-1.5 pr-3 text-[14px] font-semibold ${
                on ? "border-ink bg-card text-ink" : "border-line-field bg-transparent text-ink-mid"
              }`}
            >
              <span className={on ? "" : "opacity-45"}>
                <StockAvatar symbol={o.stock.symbol} size={26} />
              </span>
              {o.stock.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One amount's quote: the plan first, for the batch the rate after it is read from (useEarnRates, or the dev gallery's
 * fixed rate), then the quote with that rate once it's in.
 */
function useEarnQuote(p: {
  user: `0x${string}`;
  data: PositionData;
  offer: EarnOpen;
  options: BackingOption[];
  creditRaw: bigint;
  fixedApyAfter: number | undefined;
}) {
  const { user, data, offer, options, creditRaw } = p;
  const apyNow = aprToApy(data.apr);
  const base = { offer, position: data, options, cash: data.cash, creditRaw, creditApyNow: apyNow };
  const draft = earnQuote({ ...base, creditApyAfter: null });
  const read = useEarnRates({
    user,
    backing: draft.plan.backing,
    creditRaw,
    limit: draft.plan.limit,
    cash: data.cash,
    apyNow,
    enabled: p.fixedApyAfter === undefined,
  });
  const apyAfter = p.fixedApyAfter ?? read.apyAfter;
  return apyAfter === null ? draft : earnQuote({ ...base, creditApyAfter: apyAfter });
}

/** What backs it: what the plan puts in use and what's in use already, the stock picked first. */
function backedByOf(plan: EarnQuote["plan"], options: BackingOption[], data: PositionData) {
  const lead = plan.backing[0]?.stock.symbol ?? [...options].sort((a, b) => b.cf - a.cf)[0]?.stock.symbol;
  const adding = plan.backing.length
    ? plan.backing.map((b) => b.stock.symbol)
    : data.totalBackingUsd > 0 || !lead
      ? []
      : [lead];
  return backers(data.holdings, adding, lead);
}

/** What's left after the credit's cost: a percent a year, and in dollars once an amount is typed. */
function leftTextOf(amount: number, quote: EarnQuote, offer: EarnOpen): string {
  const left = amount > 0 ? quote.left : offer.rates.left;
  if (left === null) return "…";
  if (amount > 0 && quote.leftUsdYear !== null)
    return `about ${pctText(left)} · ${quote.leftUsdYear >= 1 ? formatUsdTrim(quote.leftUsdYear) : "under $1"} a year`;
  return `about ${pctText(left)} a year`;
}

/** The amount card's source: the stock that backs it, and how many more. */
function BackedBySource({ backedBy }: { backedBy: { symbol: string; name: string }[] }) {
  return (
    <AmountSource mark={<StockAvatar symbol={backedBy[0].symbol} size={16} />}>
      Backed by {backedBy[0].name}
      {backedBy.length > 1 ? ` +${backedBy.length - 1}` : ""}
    </AmountSource>
  );
}

/** Why this amount can't go ahead (act), or that markets are closed (watch). */
function EarnNote({ block, closed }: { block: string | null; closed: boolean }) {
  if (!block && !closed) return null;
  return (
    <p role="status" className={`m-0 text-[13px] leading-snug ${block ? "text-act" : "text-watch-text"}`}>
      {block ?? "Stock markets are closed. You can still do this, but prices can jump when they reopen."}
    </p>
  );
}

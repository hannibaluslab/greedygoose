"use client";

import { creditTick } from "@/lib/creditBuy/copy";
import { AmountArrow, AmountBadge, AmountField, AmountSource, YouGet } from "../kit/AmountField";
import { StockAvatar, tickerOf } from "../kit/StockAvatar";
import { TxButton, TxError } from "../TxUi";
import { StatusChange, StatusMoveBar, StatusPill } from "../Status";
import { BacksIcon } from "../kit/icons";
import { wholeUsd } from "./CreditBuyBacking";
import type { useBuyQuote } from "@/hooks/useBuyQuote";
import type { useCreditBuy } from "@/hooks/useCreditBuy";
import type { PositionData } from "@/hooks/usePosition";
import { monthlyCost } from "@/lib/aave/math";
import { PROTECT_LINE } from "@/lib/agents/list";
import { backers, shortNames, type BackingOption, type BackingPick, type CreditPlan } from "@/lib/creditBuy";
import {
  ceilCents,
  floorCents,
  formatShares,
  formatUsd,
  formatUsdTrim,
  inWords,
  monthlyCostText,
} from "@/lib/formatting";
import { STATUS_LABEL } from "@/lib/risk/status";
import { BUY_LIMITS, type BuyQuote, type quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { backingShares } from "@/lib/holding";
import { rawToShares } from "@/lib/tokens/b20";
import type { ReserveAsset } from "@/lib/tokens/registry";
import { leverageOf, leverageText } from "@/lib/leverage";

/** What a backing is worth, rounded up so it's never shown as less than goes in: cents under $100, dollars above. */
const backedText = (n: number) => (n < 100 ? formatUsd(ceilCents(n)) : formatUsdTrim(Math.ceil(n)));
/** MAX's amount: the most there is, to the cent, rounded down ("0.69", "417.35"). */
export const maxText = (n: number) => String(floorCents(Math.max(0, n)));

/**
 * What backs it once it lands: what this buy puts in use (the picked holding first) and what's in use already.
 * Under the amount: what backs it, "Backed by 1.16 Apple · $290", all of it, or nothing new (Credit ready).
 */
export function backingLineOf(data: PositionData, chosen: BackingOption | null, pick: BackingPick): string {
  const chosenHolding = chosen ? (data.holdings.find((h) => h.symbol === chosen.stock.symbol) ?? null) : null;
  const backedShares =
    chosen && chosenHolding ? rawToShares(pick.raw, chosenHolding.multiplier, chosen.stock.decimals) : 0;
  const backedUsd = chosen && chosen.freeRaw > 0n ? (Number(pick.raw) / Number(chosen.freeRaw)) * chosen.freeUsd : 0;
  return !chosen
    ? "Nothing new goes in"
    : pick.raw <= 0n
      ? `Backed by ${chosen.stock.name}`
      : `Backed by ${pick.raw >= chosen.freeRaw ? "all " : ""}${formatShares(backedShares)} ${chosen.stock.name} · ${backedText(backedUsd)}`;
}

/** Step 3 (F2-5): the amount to buy on credit, what backs it, how far it moves the credit, and the Credit Buy button. */
export function CreditBuyAmountStep({
  data,
  stock,
  chosen,
  pick,
  reachUsd,
  raw,
  setRaw,
  ack,
  setAck,
  amount,
  quote,
  q,
  econ,
  oraclePriceUsd,
  plan,
  blocker,
  ready,
  protectOn,
  sellOn,
  feeBlocked,
  feeLoading,
  isConnected,
  signable,
  tx,
}: {
  data: PositionData;
  stock: ReserveAsset;
  chosen: BackingOption | null;
  pick: BackingPick;
  reachUsd: number;
  raw: string;
  setRaw: (raw: string) => void;
  ack: boolean;
  setAck: (ack: boolean) => void;
  amount: number;
  quote: ReturnType<typeof useBuyQuote>;
  q: BuyQuote | null;
  econ: ReturnType<typeof quoteEconomics> | null;
  oraclePriceUsd: number;
  plan: CreditPlan;
  blocker: string | null;
  ready: boolean;
  protectOn: boolean;
  /** Protect may sell backing stock too (its sell grant is on). */
  sellOn: boolean;
  feeBlocked: boolean;
  feeLoading: boolean;
  isConnected: boolean;
  /** Whether Credit Buy has a batch prepared to sign. */
  signable: boolean;
  tx: ReturnType<typeof useCreditBuy>;
}) {
  const { sign, phase, error, reset, checking, blocked } = tx;
  const backingLine = backingLineOf(data, chosen, pick);
  // A small market: what the buy pays over Aave's price, once nothing blocks it.
  const warnPremium =
    !blocker && econ && econ.premium > BUY_LIMITS.warnPremium
      ? `You’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. The market for ${stock.name} is small.`
      : null;

  return (
    <>
      <AmountField
        label="On credit"
        source={
          chosen ? (
            <AmountSource mark={<StockAvatar symbol={chosen.stock.symbol} size={16} />}>
              Back: {chosen.stock.name}
            </AmountSource>
          ) : (
            <AmountSource mark={<BacksIcon size={12} />}>Credit ready</AmountSource>
          )
        }
        badge={<AmountBadge kind="credit" />}
        value={raw}
        onValue={(v) => {
          setRaw(v);
          setAck(false);
        }}
        onMax={() => {
          // To the cent, rounded down: a small account's $0.69 fills $0.69, not $0.
          setRaw(maxText(reachUsd));
          setAck(false);
        }}
        hint={
          <span className="flex justify-between gap-2 text-[12.5px] text-ink-mid">
            <span className="num truncate font-medium text-ink">{backingLine}</span>
            <span className="shrink-0 whitespace-nowrap">
              Up to <b className="num font-semibold text-ink">{wholeUsd(reachUsd)}</b>
            </span>
          </span>
        }
        autoFocus
      />
      <AmountArrow />
      <YouGet
        symbol={stock.symbol}
        shares={quote.isFetching && amount > 0 ? null : econ ? econ.shares : 0}
        priceUsd={econ ? econ.price : oraclePriceUsd}
      />
      <CreditMove data={data} plan={plan} amount={amount} />
      {(blocker || warnPremium || plan.priceMayMove) && (
        <p role="status" className={`m-0 text-[13px] leading-snug ${blocker ? "text-act" : "text-watch-text"}`}>
          {blocker ??
            warnPremium ??
            "Stock markets are closed. You can still buy, but the price can jump when they reopen."}
        </p>
      )}
      {ready && econ && q && (
        <BatchNote
          data={data}
          plan={plan}
          chosen={chosen}
          pick={pick}
          amount={amount}
          usd={econ.usd}
          venue={q.venue}
          protectOn={protectOn}
          sellOn={sellOn}
        />
      )}
      {ready && plan.extraConfirm && (
        <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-px size-[18px] shrink-0 accent-neg"
          />
          {creditTick(plan)}
        </label>
      )}
      {feeBlocked && (
        <p role="alert" className="m-0 text-[13px] text-act">
          Your account can’t pay network fees from your cash right now, so this Credit Buy can’t go through.
        </p>
      )}
      <TxError error={error} />
      <div className="mt-1">
        <TxButton
          label="Credit Buy"
          size="md"
          phase={phase}
          checking={checking}
          preview={!isConnected}
          disabled={!signable || feeLoading || blocked || phase === "done"}
          onClick={() => {
            if (!signable) return;
            if (phase !== "idle") reset();
            void sign();
          }}
        />
      </div>
    </>
  );
}

/**
 * Board 34 (Adrian: say how much it moves): the bar from now to after, and the status change. `cost` replaces the Cost
 * cell's rate and monthly cost (the Cash row: what this credit costs beside what the cash earns).
 */
export function CreditMove({
  data,
  plan,
  amount,
  cost,
}: {
  data: PositionData;
  plan: CreditPlan;
  amount: number;
  cost?: string;
}) {
  // What you hold ÷ your own money, now and once the buy lands (the credit comes in as stock): "1.1x → 1.2x".
  const holdUsd = data.stocksUsd + data.cashUsd;
  const leverageNow = leverageText(leverageOf({ holdUsd, owedUsd: data.debtUsd }) ?? 1);
  const leverageAfter = leverageText(leverageOf({ holdUsd: holdUsd + amount, owedUsd: data.debtUsd + amount }) ?? 1);
  // The bar moves once there's an amount the plan can read.
  const moved = amount > 0 && Number.isFinite(plan.hfAfter);

  return (
    <div className="flex flex-col gap-2 rounded-[16px] border border-line-field bg-card px-3.5 py-3 leading-[normal]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-ink-mid">My credit</span>
        {moved && plan.after !== plan.before ? (
          <StatusChange from={plan.before} to={plan.after} />
        ) : (
          <StatusPill status={plan.before} size="sm" />
        )}
      </div>
      <StatusMoveBar
        now={data.healthFactor}
        after={moved ? plan.hfAfter : undefined}
        label={
          moved ? `Now ${STATUS_LABEL[plan.before]}, after this ${STATUS_LABEL[plan.after]}` : STATUS_LABEL[plan.before]
        }
        className={moved ? "mt-5" : "mt-2"}
      />
      {/* Cost | Leverage, as the Repay card pairs Cost | Credit available (Adrian: show how leverage moves). */}
      <div className="num mt-1 grid grid-cols-2 border-t border-line-field pt-2 text-[12.5px]">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-subtle">Cost</span>
          <span className="truncate font-semibold text-ink-2">
            {cost ?? `${(data.apr * 100).toFixed(1)}% · ${monthlyCostText(monthlyCost(amount, data.apr))}`}
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 border-l border-line-field pl-3">
          <span className="text-subtle">Leverage</span>
          <span className="truncate whitespace-nowrap font-semibold text-ink-2">
            {leverageNow}
            {moved && leverageAfter !== leverageNow && (
              <>
                {" "}
                <span aria-hidden className="font-[system-ui] font-normal text-ink-mid">
                  →
                </span>
                <span className="sr-only">after this</span> {leverageAfter}
              </>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

/** D7: every move in the batch, the stock put in use too. */
function BatchNote({
  data,
  plan,
  chosen,
  pick,
  amount,
  usd,
  venue,
  protectOn,
  sellOn,
}: {
  data: PositionData;
  plan: CreditPlan;
  chosen: BackingOption | null;
  pick: BackingPick;
  amount: number;
  usd: number;
  venue: BuyQuote["venue"];
  protectOn: boolean;
  sellOn: boolean;
}) {
  const lead = chosen?.stock.symbol;
  const adding = pick.raw > 0n && lead ? [lead] : [];
  const against = backers(data.holdings, adding, lead);
  const againstNames = against.map((h) => h.name);
  return (
    <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
      In one go:{" "}
      {inWords([
        // Every stock the batch puts in use, or a throw: a line of what's signed is never dropped.
        ...backingShares(plan.backing, data.holdings).map(
          (b) => `${formatShares(b.shares)} ${tickerOf(b.symbol)} goes in use to back credit`,
        ),
        `${formatUsd(amount)} of credit is taken`,
        `exactly ${formatUsd(usd)} is approved for the ${VENUE_LABEL[venue]} router and swapped`,
      ])}
      . You’ll owe {formatUsd(data.debtUsd + amount)}, backed by {shortNames(againstNames)}.{" "}
      {riskNote(againstNames, protectOn, sellOn)}
    </p>
  );
}

/**
 * The risk line (F2-6's, now in the amount step's small print). The board's "Your cash is never touched" is left out:
 * the network fee comes from cash, and Protect repays from savings first (D11). It says Protect sells only while its
 * selling is on, as Earn with stocks' line does (lib/earnWithStocks/copy.ts).
 */
function riskNote(backers: string[], protectOn: boolean, sellOn: boolean): string {
  const one = backers.length === 1 ? backers[0] : null;
  // Protect's line (Adrian, 2026-10-19): Protect steps in only under 1.03, and brings the credit back to Watch.
  if (protectOn) {
    const falls = `${one ? `If ${one} falls` : "If your stocks fall"}, you can repay. If your credit falls under ${PROTECT_LINE}`;
    return sellOn
      ? `${falls}, Protector repays from your cash, then sells a little ${one ?? "of them"} to bring it back to Watch.`
      : `${falls}, Protector repays from your cash. Protector won’t sell your ${one ? "stock" : "stocks"}.`;
  }
  return one
    ? `If ${one} falls, you can repay. If it falls too far, part of it can be sold to repay what you owe.`
    : "If your stocks fall, you can repay. If they fall too far, part of them can be sold to repay what you owe.";
}

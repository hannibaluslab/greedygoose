"use client";

import { AmountArrow, AmountBadge, AmountField, AmountSource, YouGetCash } from "../kit/AmountField";
import { StockAvatar } from "../kit/StockAvatar";
import { BacksIcon } from "../kit/icons";
import { TxButton, TxError } from "../TxUi";
import { backingLineOf, CreditMove, maxText } from "./CreditBuyAmountStep";
import { wholeUsd } from "./CreditBuyBacking";
import type { PositionData } from "@/hooks/usePosition";
import type { TxPhase } from "@/hooks/useTx";
import type { AgentStatus } from "@/lib/agents/status";
import { backers, type BackingOption, type BackingPick, type CreditPlan } from "@/lib/creditBuy";
import { gapLine, toCashLine, type ToCashQuote } from "@/lib/creditBuy/toCash";
import { earnRiskLine, earnSmallPrint, earnTick, pctText } from "@/lib/earnWithStocks";
import { backingShares } from "@/lib/holding";

/** What the button needs from the write (useTx), so the dev gallery can draw the step without one. */
type CashStepTx = {
  phase: TxPhase;
  error: string | null;
  checking: boolean;
  blocked: boolean;
  /** JAW's sheet open or the batch confirming: the amount waits, as a send's or a trade's does. */
  busy?: boolean;
  onSign: () => void;
};

/**
 * Credit Buy's Cash row, the amount: credit on step 1's backing, straight into savings in one batch. It shows what the
 * cash earns beside what this credit costs, and the gap, even when credit costs more: that is allowed here, with the
 * gap shown before the tap (SPEC.md › Credit Buy). Then how far it moves the credit, the small print and the risk tick,
 * as the stock route does.
 */
export function CreditBuyCashStep({
  data,
  chosen,
  pick,
  reachUsd,
  raw,
  setRaw,
  ack,
  setAck,
  amount,
  plan,
  quote,
  costText,
  blocker,
  ready,
  protect,
  sell,
  feeBlocked,
  feeLoading,
  preview,
  signable,
  tx,
}: {
  data: PositionData;
  chosen: BackingOption | null;
  pick: BackingPick;
  reachUsd: number;
  raw: string;
  setRaw: (raw: string) => void;
  ack: boolean;
  setAck: (ack: boolean) => void;
  amount: number;
  plan: CreditPlan;
  quote: ToCashQuote;
  /** The Cost cell's rate (costCellText); the gallery leaves it to the quote. */
  costText?: string;
  blocker: string | null;
  ready: boolean;
  protect: AgentStatus;
  sell: AgentStatus;
  feeBlocked: boolean;
  feeLoading: boolean;
  /** Signed out (the public link): the button previews. */
  preview: boolean;
  signable: boolean;
  tx: CashStepTx;
}) {
  const cost = costText ?? (quote.cost === null ? "…" : pctText(quote.cost));
  const lead = chosen?.stock.symbol;
  const names = backers(data.holdings, pick.raw > 0n && lead ? [lead] : [], lead).map((h) => h.name);

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
          setRaw(maxText(reachUsd));
          setAck(false);
        }}
        hint={
          <span className="flex justify-between gap-2 text-[12.5px] text-ink-mid">
            <span className="num truncate font-medium text-ink">{backingLineOf(data, chosen, pick)}</span>
            <span className="shrink-0 whitespace-nowrap">
              Up to <b className="num font-semibold text-ink">{wholeUsd(reachUsd)}</b>
            </span>
          </span>
        }
        autoFocus
        disabled={tx.busy}
      />
      <AmountArrow />
      <YouGetCash usd={amount} line={toCashLine(quote.earn)} />
      <CreditMove data={data} plan={plan} amount={amount} cost={`${cost} · Earns ${pctText(quote.earn)}`} />
      {blocker ? (
        <p role="status" className="m-0 text-[13px] leading-snug text-act">
          {blocker}
        </p>
      ) : (
        quote.gap !== null && (
          <p
            role="status"
            className={`m-0 text-[13px] leading-snug ${quote.gap < 0 ? "text-watch-text" : "text-ink-mid"}`}
          >
            {gapLine(quote.gap, amount)}
          </p>
        )
      )}
      {!blocker && plan.priceMayMove && (
        <p role="status" className="m-0 text-[13px] leading-snug text-watch-text">
          Stock markets are closed. You can still do this, but prices can jump when they reopen.
        </p>
      )}
      {ready && (
        <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
          {earnSmallPrint({
            // Every stock the batch puts in use, or a throw: a line of what's signed is never dropped.
            backing: backingShares(plan.backing, data.holdings),
            amountUsd: amount,
            owedUsd: data.debtUsd + amount,
            backedBy: names,
            risk: earnRiskLine({ names, protect, sell }),
          })}
        </p>
      )}
      {ready && plan.extraConfirm && (
        <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]"
          />
          {earnTick(plan.after)}
        </label>
      )}
      {feeBlocked && (
        <p role="alert" className="m-0 text-[13px] text-act">
          Your account can’t pay network fees from your cash right now, so this Credit Buy can’t go through.
        </p>
      )}
      <TxError error={tx.error} />
      <div className="mt-1">
        <TxButton
          label="Credit Buy"
          size="md"
          phase={tx.phase}
          checking={tx.checking}
          preview={preview}
          disabled={!signable || feeLoading || tx.blocked || tx.phase === "done"}
          onClick={() => signable && tx.onSign()}
        />
      </div>
    </>
  );
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountBadge, AmountField } from "./AmountField";
import { CashMark } from "./AssetPicker";
import { Button } from "./Button";
import { WhiteCard } from "./Screen";
import { StatusPill } from "./Status";
import { StockAvatar } from "./StockAvatar";
import { Summary } from "./Summary";
import { TxButton, TxError } from "./TxUi";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useCollateralFactorsRead, usePosition, type PositionData } from "@/hooks/usePosition";
import { repaySign, useRepayWith } from "@/hooks/useRepay";
import { useSellQuote } from "@/hooks/useSell";
import { formatUsdTrim } from "@/lib/formatting";
import {
  REPAY_COPY,
  REPAY_FORM,
  noSourceLine,
  pickedSource,
  planRepay,
  quickPicks,
  repayForm,
  repaySmallPrint,
  repaySources,
  statusAfter,
  type RepayAction,
  type RepayForm,
  type RepaySource,
  type RepayView,
} from "@/lib/repay";

/** What's owed, rounded up to the dollar as on Home's Credit card: never shown as less than it is. */
const owed = (usd: number) => formatUsdTrim(Math.max(0, Math.ceil(usd)));
/** What's owed after, rounded up to the cent: a small repay still shows what it changes ("$2.01", "$0"). */
const owedAfter = (usd: number) => formatUsdTrim(Math.max(0, Math.ceil(usd * 100 - 1e-6) / 100));

/**
 * Repay is one choice: pay with (Adrian, 2026-10-15). A sheet over the page it opens from (Home's Repay, the Credit and
 * Cash sheets, Credit Buy's Repay links, Protect's heads-up): the big "You owe $X" with its status, then "Pay with" (the
 * cash, each stock held free, each stock that backs the credit, every row with the status it would land in), one amount
 * in dollars, typed or filled by a quick pick (All, $25, $50), what you owe after, who pays the network fee, and one
 * Repay button that opens JAW's sheet straight away. With nothing owed it says only that. The status bar, the cost, the credit available, Buy more and Protect's settings live on the Credit
 * sheet. The batch is prepared only while the sheet is open and idle (useRepayWith), and a landed repay closes the sheet
 * with its toast. All the money maths is lib/repay.ts.
 */
export function RepaySheet({
  open, address, onClose, onTopUp,
}: {
  open: boolean;
  address: `0x${string}`;
  onClose: () => void;
  /** Nothing to repay with: Add money opens the Top up sheet in this one's place. */
  onTopUp: () => void;
}) {
  const { isConnected } = useAccount();
  const { data } = usePosition(address);
  const cfRead = useCollateralFactorsRead(data?.holdings);
  const fee = useFeeSupport();
  const [form, setForm] = useState<RepayForm>(REPAY_FORM);
  const paid = useRef<string | null>(null);

  const sources = data ? repaySources(data, cfRead.cfs) : [];
  const source = pickedSource(sources, form.source);
  const stock = source && source.kind !== "cash" ? source : null;
  // A stock reads two quotes: all the shares it can sell (All, and the floor per share), then the shares this amount sells.
  const maxQuote = useSellQuote(stock?.stock, stock?.maxSharesRaw ?? 0n);
  const sized = data && source ? planRepay({ data, source, form, maxQuote }) : null;
  const quote = useSellQuote(stock?.stock, sized?.sharesRaw ?? 0n);
  const view = data && source ? planRepay({ data, source, form, maxQuote, quote }) : null;

  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Repay would sign now, prepared while the sheet is open and idle so the tap opens JAW's sheet at once.
  const sign = open && data && view && !feeBlocked ? repaySign(view, address, data.debtRaw) : null;
  const tx = useRepayWith(sign);

  useEffect(() => {
    if (tx.phase !== "done" || paid.current === null) return;
    toast.success(paid.current);
    paid.current = null;
    onClose();
  }, [tx.phase, onClose]);

  const dispatch = (action: RepayAction) => {
    if (tx.phase === "failed") tx.reset();
    setForm((f) => repayForm(f, action));
  };
  // Backing rows wait for the collateral factors, so the default row doesn't jump once they're read.
  const waitingForCfs = !!data && !cfRead.cfs && !cfRead.failed && data.holdings.some((h) => h.lockedRaw > 0n);

  return (
    <SheetShell open={open} onOpenChange={(next) => !next && onClose()} title={REPAY_COPY.title}>
      <SheetSteps stepKey="repay" className="flex flex-col gap-4">
        {data?.debtRaw === 0n ? (
          // Nothing owed: this line alone, with nothing to pick, type or tap.
          <p className="m-0 px-1 pb-2 text-[17px] text-ink-mid">{REPAY_COPY.nothingOwed}</p>
        ) : !data || waitingForCfs ? (
          <div aria-busy className="h-[420px] animate-pulse rounded-[22px] bg-chip" />
        ) : !view || !source ? (
          <>
            <Owed data={data} />
            <div className="flex flex-col gap-3">
              <p className="m-0 px-1 text-[15px] leading-snug text-ink-mid">{noSourceLine(data)}</p>
              <Button variant="dark" onClick={onTopUp} className="w-full">{REPAY_COPY.addMoney}</Button>
            </div>
          </>
        ) : (
          <>
            <Owed data={data} />
            <PayWith data={data} sources={sources} view={view} disabled={tx.busy} onPick={(id) => dispatch({ type: "source", id })} />
            <Amount view={view} form={form} disabled={tx.busy} dispatch={dispatch} />
            <Summary
              rows={[
                { label: REPAY_COPY.oweAfter, value: view.amountUsd > 0 ? owedAfter(view.oweAfterUsd) : "—" },
                { label: REPAY_COPY.fee, value: view.fee },
              ]}
            />
            {view.note && (
              <p role="status" className={`m-0 text-[13px] leading-snug ${view.note.tone === "act" ? "text-act" : "text-watch-text"}`}>
                {view.note.text}
              </p>
            )}
            {view.ready && repaySmallPrint(view) && <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">{repaySmallPrint(view)}</p>}
            {feeBlocked && <p role="alert" className="m-0 text-[13px] text-act">{REPAY_COPY.feeUnsupported}</p>}
            <TxError error={tx.error} />
            <TxButton
              label={REPAY_COPY.button}
              size="md"
              phase={tx.phase}
              checking={tx.checking}
              preview={!isConnected}
              disabled={!sign || fee.loading || tx.blocked}
              onClick={() => {
                if (!sign) return;
                if (tx.phase === "failed") tx.reset();
                paid.current = view.done;
                void tx.sign();
              }}
            />
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

/** The one big number: "You owe $X", with the status it's in now. */
function Owed({ data }: { data: PositionData }) {
  return (
    <WhiteCard className="flex items-end justify-between gap-3 px-[18px] py-[18px] leading-[normal]">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[15px] font-medium text-ink-mid">{REPAY_COPY.owe}</span>
        <span className={`num ${data.debtUsd >= 100_000 ? "text-[38px]" : "text-5xl"} font-semibold leading-none tracking-[-0.04em]`}>{owed(data.debtUsd)}</span>
      </div>
      <span className="mb-1"><StatusPill status={data.status} size="lg" /></span>
    </WhiteCard>
  );
}

/**
 * "Pay with": the cash, the stocks held free, the stocks that back the credit, each with what it is and the status the
 * amount on screen would land in. One line under the list says why cash or another stock is the safest, once, when a
 * stock that backs the credit is on it.
 */
function PayWith({
  data, sources, view, disabled, onPick,
}: { data: PositionData; sources: RepaySource[]; view: RepayView; disabled: boolean; onPick: (id: string) => void }) {
  return (
    <section className="flex flex-col gap-2">
      {/* One label for the pills' column ("After"), so each row keeps its room for what it is. */}
      <div className="flex items-center justify-between pl-1 pr-[52px] font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
        <h3 id="pay-with" className="m-0 font-[inherit] text-[11px]">{REPAY_COPY.payWith}</h3>
        <span aria-hidden>{REPAY_COPY.after}</span>
      </div>
      <div role="radiogroup" aria-labelledby="pay-with" className="flex flex-col gap-0.5 rounded-[22px] bg-card p-1.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
        {sources.map((s) => {
          const on = s.id === view.source.id;
          const after = on ? view.after : statusAfter(s, view.amountUsd, data);
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onPick(s.id)}
              className={`flex min-h-[56px] w-full items-center gap-3 rounded-[16px] px-2.5 py-2 text-left leading-[normal] transition disabled:opacity-60 ${
                on ? "bg-pill" : "hover:bg-pill active:bg-pill-strong"
              }`}
            >
              {s.kind === "cash" ? <CashMark size={32} /> : <StockAvatar symbol={s.stock!.symbol} size={32} />}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[15px] font-semibold text-ink">{s.name}</span>
                <span className="num truncate text-[12px] leading-[1.3] text-ink-mid">{s.sub}</span>
              </span>
              <span className="shrink-0">
                <span className="sr-only">{REPAY_COPY.after}: </span>
                <StatusPill status={after} size="row" />
              </span>
              {on ? (
                <span aria-hidden className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand shadow-[0_0_0_1.5px_#0e0d0b]">
                  <span className="size-2 rounded-full bg-ink" />
                </span>
              ) : (
                <span aria-hidden className="size-[22px] shrink-0 rounded-full border-[1.5px] border-[#d9d2c3]" />
              )}
            </button>
          );
        })}
      </div>
      {sources.some((s) => s.kind === "backing") && <p className="m-0 px-1 text-[12px] leading-snug text-subtle">{REPAY_COPY.safest}</p>}
    </section>
  );
}

/**
 * One amount in dollars, typed in the kit's AmountField (the numeric keyboard), All by default; the shares a stock sells
 * under it; the quick picks $25 · $50 · All, which fill it. More than the row can pay or than is owed snaps back to the
 * most, with one plain line under the picks.
 */
function Amount({ view, form, disabled, dispatch }: { view: RepayView; form: RepayForm; disabled: boolean; dispatch: (a: RepayAction) => void }) {
  const picks = quickPicks(view.max);
  const { source } = view;
  return (
    <div className="flex flex-col gap-2.5">
      <AmountField
        label={REPAY_COPY.amount}
        badge={source.kind === "cash" ? <AmountBadge kind="cash" /> : <StockAvatar symbol={source.stock!.symbol} />}
        value={view.fieldText}
        onValue={(value) => dispatch({ type: "amount", value, max: view.max })}
        disabled={disabled}
        hint={view.sharesLine ?? undefined}
      />
      <div role="radiogroup" aria-label="Amount to repay" className="grid gap-2" style={{ gridTemplateColumns: `repeat(${picks.length + 1}, minmax(0, 1fr))` }}>
        {picks.map((usd) => (
          <Chip key={usd} selected={!form.all && Number(form.amount) === usd} disabled={disabled} onClick={() => dispatch({ type: "chip", usd, max: view.max })}>
            {formatUsdTrim(usd)}
          </Chip>
        ))}
        <Chip selected={view.all} disabled={disabled} onClick={() => dispatch({ type: "all" })}>{REPAY_COPY.all}</Chip>
      </div>
      {view.snapLine && <p role="status" className="m-0 px-1 text-[13px] leading-snug text-ink-mid">{view.snapLine}</p>}
    </div>
  );
}

function Chip({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`num flex h-10 items-center justify-center rounded-[20px] text-sm disabled:opacity-60 ${selected ? "bg-ink font-semibold text-on-ink" : "bg-chip font-medium text-ink-2"}`}
    >
      {children}
    </button>
  );
}

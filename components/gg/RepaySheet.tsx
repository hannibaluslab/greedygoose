"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountBadge, AmountField } from "./AmountField";
import { AssetPicker, assetMark, type PickerRow } from "./AssetPicker";
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
/** A tap on the dim that just closed the Pay with list doesn't also close the sheet (the dim reports it after the list). */
const MENU_TAP_MS = 500;
/** The mark for a source: cash's "$", or the stock's logo. */
const sourceMark = (s: RepaySource, size: number) => assetMark(s.kind === "cash" ? "cash" : s.stock!.symbol, size);

/**
 * Repay is one choice: pay with (Adrian, 2026-10-15). A sheet over the page it opens from (Home's Repay, the Credit and
 * Cash sheets, Credit Buy's Repay links, Protect's heads-up), on one 390×844 screen without scrolling (Adrian,
 * 2026-10-15): the big "You owe $X" with its status; "Pay with" and one pill naming the source, which opens the list
 * (the cash, each stock held free, each stock that backs the credit, every row with the status it would land in, and
 * the "safest" line under them), as the Trade sheet's From picker does; one amount in dollars, typed or filled by a
 * quick pick ($25, $50, All); what you owe after and who pays the network fee; and one Repay button that opens JAW's
 * sheet straight away. A stock sale's small print sits under the button. With nothing owed it says only that. It is
 * the one credit sheet (Adrian, 2026-10-15): Home's Credit ⓘ and Invest's status pill open it too, and the Credit
 * sheet (its status bar, cost, credit available, Buy more, Protect row and "Use credit for buying") is gone; Protect
 * stays on the Agents tab. The batch is prepared only while the sheet is open and idle (useRepayWith), and a landed
 * repay closes the sheet with its toast. All the money maths is lib/repay.ts.
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
  const [menu, setMenu] = useState(false);
  const menuClosedAt = useRef(0);
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
  /** A tap away closed the list. Only a tap on the dim (outside the sheet) is swallowed; Close, in the sheet, still closes it. */
  const closeMenu = (e?: Event) => {
    const inSheet = e?.target instanceof Element && !!e.target.closest('[role="dialog"]');
    if (!inSheet) menuClosedAt.current = Date.now();
    setMenu(false);
  };
  // Escape, the dim and Close come here, as in the Trade sheet. Escape with the list open closes the list; the dim's
  // tap that just closed it closes nothing else; Close closes the sheet (its press already closed the list).
  const onOpenChange = (next: boolean) => {
    if (next) return;
    if (menu) return setMenu(false);
    if (Date.now() - menuClosedAt.current < MENU_TAP_MS) return;
    onClose();
  };
  // Backing rows wait for the collateral factors, so the default row doesn't jump once they're read.
  const waitingForCfs = !!data && !cfRead.cfs && !cfRead.failed && data.holdings.some((h) => h.lockedRaw > 0n);

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} title={REPAY_COPY.title}>
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
            <PayWith
              data={data}
              sources={sources}
              view={view}
              open={menu}
              disabled={tx.busy}
              onToggle={() => setMenu((m) => !m)}
              onClose={closeMenu}
              onPick={(id) => {
                setMenu(false);
                dispatch({ type: "source", id });
              }}
            />
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
            {/* A stock sale's small print (D7) sits under the button, so the sheet's one idea fits one screen. */}
            {view.ready && repaySmallPrint(view) && <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">{repaySmallPrint(view)}</p>}
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
 * "Pay with" and one pill naming the source (its mark and name), as the Trade sheet's From picker. The pill opens the
 * list in Adrian's order: the cash, the stocks held free, the stocks that back the credit, each row with its mark, its
 * name, what it can pay ("$X in your cash", "$X free", "$X backs your credit") and the status the amount on screen would
 * land in. One line under the list says why cash or another stock is the safest, when a stock that backs the credit is
 * on it. The row sits at the content's edges, so the list is as wide as the content.
 */
function PayWith({
  data, sources, view, open, disabled, onToggle, onClose, onPick,
}: {
  data: PositionData;
  sources: RepaySource[];
  view: RepayView;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onClose: (e: Event) => void;
  onPick: (id: string) => void;
}) {
  const { source } = view;
  const rows: PickerRow[] = sources.map((s) => {
    const after = s.id === source.id ? view.after : statusAfter(s, view.amountUsd, data);
    return {
      id: s.id,
      name: s.name,
      mark: sourceMark(s, 32),
      sub: s.sub,
      aside: (
        <>
          <span className="sr-only">{REPAY_COPY.after}: </span>
          <StatusPill status={after} size="row" />
        </>
      ),
    };
  });
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 pl-1">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">{REPAY_COPY.payWith}</span>
      <AssetPicker
        label={REPAY_COPY.payWithLabel(source.name, source.sub)}
        title={REPAY_COPY.payWith}
        titleAside={<span aria-hidden className="pr-[34px]">{REPAY_COPY.after}</span>}
        name={source.name}
        mark={sourceMark(source, 18)}
        rows={rows}
        selected={source.id}
        open={open}
        onToggle={onToggle}
        onClose={onClose}
        onPick={onPick}
        disabled={disabled}
        footer={sources.some((s) => s.kind === "backing") ? <p className="m-0 text-[12px] leading-snug text-subtle">{REPAY_COPY.safest}</p> : undefined}
        wide
        peek
      />
    </div>
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

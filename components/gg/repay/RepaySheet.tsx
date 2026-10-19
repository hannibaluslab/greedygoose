"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { Button } from "@/components/gg/kit/Button";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useMenuGuard } from "@/hooks/useMenuGuard";
import { useBackingFactorsRead, usePosition } from "@/hooks/usePosition";
import { repaySign, useRepayWith } from "@/hooks/useRepay";
import { useSellQuote } from "@/hooks/useSell";
import {
  REPAY_COPY,
  REPAY_FORM,
  noSourceLine,
  pickedSource,
  planRepay,
  planRepaySheet,
  repayForm,
  repaySources,
  type RepayAction,
  type FreeUpTick,
  type RepayData,
  type RepayForm,
  type RepayView,
} from "@/lib/repay";
import { FreeUpList, type FreeUpItem } from "./FreeUpList";
import { OweCard } from "./OweCard";
import { PayBox } from "./PayBox";
import { RiskTick } from "./RiskTick";

const RISK_TICK = "I understand: if prices fall, part of my stocks can be sold.";

/**
 * The credit sheet (canvas boards 1–8, v2): "You owe" with where it lands; "Pay with | Repay"; then, optionally, "Also
 * free up stocks", the stocks that back credit, ticked and taken out in the same signature as the repay, all under one
 * limit at the 1.12 line. Repay all brings every stock back. A free-up that ends in Watch asks for one tick. The money
 * maths is lib/repay.ts (the repay) and lib/freeUpPlan.ts (the free-up); the batch is useRepayWith with its take-outs.
 */
export function RepaySheet({
  open,
  address,
  onClose,
  onTopUp,
  freeUp,
}: {
  open: boolean;
  address: `0x${string}`;
  onClose: () => void;
  /** Nothing to repay with: Add money opens the Top up sheet in this one's place. */
  onTopUp: () => void;
  /** A stock to start on, ticked under "Also free up stocks" (its stock sheet's Free up shares): all it can. */
  freeUp?: string;
}) {
  const { isConnected } = useAccount();
  const { data } = usePosition(address);
  const cfRead = useBackingFactorsRead(data?.holdings);
  const fee = useFeeSupport();
  const [form, setForm] = useState<RepayForm>(REPAY_FORM);
  const { menu, setMenu, closeMenu, onOpenChange } = useMenuGuard(onClose, false);
  const [freeOpen, setFreeOpen] = useState(!!freeUp);
  // Ticked from the stock sheet: all of it, held to what the limit allows (no "prices moved" for that first cut).
  const [picks, setPicks] = useState<FreeUpTick[]>(
    freeUp ? [{ symbol: freeUp, share: 1, atRepayUsd: Number.NaN }] : [],
  );
  const [ack, setAck] = useState(false);

  const { sources, source, view } = useRepayView(data, cfRead.cfs, form);

  const {
    repayUsd,
    repaysAll,
    backing,
    stocks,
    plan,
    takeOuts,
    changes,
    smallPrint,
    moved,
    needsTick,
    label,
    doneLine,
  } = planRepaySheet({ data, cfs: cfRead.cfs, source, view, freeOpen, ticks: picks });

  const feeBlocked = isConnected && fee.state === "unsupported";
  const sign = signOf(view, data, address);
  const tx = useRepayWith(sign, takeOuts, address, open && !feeBlocked && (!needsTick || ack));

  const doneRef = useDoneToast(tx.phase, onClose);

  const dispatch = (action: RepayAction) => {
    if (tx.phase === "failed") tx.reset();
    setForm((f) => repayForm(f, action));
  };
  const waitingForCfs = waitsForCfs(data, cfRead);

  const items: FreeUpItem[] = backing.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    shares: h.backingShares,
    usd: h.backingUsd,
  }));
  const canSign = (sign !== null || (repayUsd === 0 && takeOuts.length > 0)) && (!needsTick || ack);

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} title="My credit">
      <SheetSteps stepKey="repay" className="flex flex-col gap-3">
        {data?.debtRaw === 0n ? (
          <p className="m-0 px-1 pb-2 text-[17px] text-ink-mid">{REPAY_COPY.nothingOwed}</p>
        ) : !data || waitingForCfs ? (
          <div aria-busy className="h-[420px] animate-pulse rounded-[22px] bg-chip" />
        ) : !view || !source || !plan ? (
          <>
            <OweCard data={data} after={null} creditAfterUsd={null} />
            <p className="m-0 px-1 text-[15px] leading-snug text-ink-mid">{noSourceLine(data)}</p>
            <Button variant="dark" onClick={onTopUp} className="w-full">
              {REPAY_COPY.addMoney}
            </Button>
          </>
        ) : (
          <>
            <OweCard
              data={data}
              after={changes ? { status: plan.after, healthFactor: plan.hfAfter } : null}
              creditAfterUsd={changes ? plan.creditAfterUsd : null}
            />
            <PayBox
              data={data}
              sources={sources}
              view={view}
              menuOpen={menu}
              disabled={tx.busy}
              onMenu={() => setMenu((m) => !m)}
              onMenuClose={closeMenu}
              dispatch={dispatch}
            />
            <FreeUpPart
              repaysAll={repaysAll}
              hasStocks={stocks.length > 0}
              open={freeOpen}
              items={items}
              plan={plan}
              disabled={tx.busy}
              onOpen={() => setFreeOpen(true)}
              onTick={(symbol, on, share) => {
                setAck(false);
                setPicks((ps) =>
                  on ? [...ps, { symbol, share, atRepayUsd: repayUsd }] : ps.filter((p) => p.symbol !== symbol),
                );
              }}
              onShare={(symbol, share) => {
                setAck(false);
                setPicks((ps) => ps.map((p) => (p.symbol === symbol ? { ...p, share, atRepayUsd: repayUsd } : p)));
              }}
              onClose={() => {
                setFreeOpen(false);
                setPicks([]);
                setAck(false);
              }}
            />
            <RepayNotes
              note={view.note}
              tick={needsTick ? { checked: ack, onChange: setAck } : null}
              moved={moved}
              feeBlocked={feeBlocked}
            />
            <TxError error={tx.error} />
            <TxButton
              label={label}
              size="md"
              phase={tx.phase}
              checking={tx.checking}
              preview={!isConnected}
              disabled={!canSign || fee.loading || tx.blocked}
              onClick={() => {
                if (!canSign) return;
                if (tx.phase === "failed") tx.reset();
                doneRef.current = doneLine;
                void tx.sign();
              }}
            />
            {smallPrint && <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">{smallPrint}</p>}
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}

/** "Also free up stocks · Optional" (board 1): the list stays closed until asked for. */
function AlsoFreeUp({ onOpen, disabled }: { onOpen: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={false}
      disabled={disabled}
      onClick={onOpen}
      className="flex min-h-[60px] items-center gap-3 rounded-[22px] bg-card px-4 py-2.5 text-left shadow-[0_1px_3px_rgba(14,13,11,0.06)]"
    >
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-chip">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[15px] font-semibold">Also free up stocks</span>
        <span className="text-[12.5px] text-ink-mid">Optional</span>
      </span>
    </button>
  );
}

/** Repay all (board 7): every stock that backs credit comes back in the same signature. */
function AllBack() {
  return (
    <p className="m-0 flex items-center gap-2 px-1 text-[14px] font-medium text-ink-2">
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      >
        <path d="M5 12l5 5 9-10" />
      </svg>
      All your stocks come back
    </p>
  );
}

/** "Also free up stocks": closed until asked for, the list once open, or, on Repay all, every stock coming back. */
function FreeUpPart({
  repaysAll,
  hasStocks,
  open,
  items,
  plan,
  disabled,
  onOpen,
  onTick,
  onShare,
  onClose,
}: {
  repaysAll: boolean;
  hasStocks: boolean;
  open: boolean;
  items: FreeUpItem[];
  plan: ComponentProps<typeof FreeUpList>["plan"];
  disabled: boolean;
  onOpen: () => void;
  onTick: ComponentProps<typeof FreeUpList>["onTick"];
  onShare: ComponentProps<typeof FreeUpList>["onShare"];
  onClose: () => void;
}) {
  if (repaysAll) return hasStocks && <AllBack />;
  if (!open) return hasStocks && <AlsoFreeUp onOpen={onOpen} disabled={disabled} />;
  return (
    <FreeUpList items={items} plan={plan} disabled={disabled} onTick={onTick} onShare={onShare} onClose={onClose} />
  );
}

/** The lines above the button: why it can't go (or what to look out for), the risk tick, prices moved, the fee. */
function RepayNotes({
  note,
  tick,
  moved,
  feeBlocked,
}: {
  note: { text: string; tone: "act" | "watch" } | null;
  tick: { checked: boolean; onChange: (on: boolean) => void } | null;
  moved: boolean;
  feeBlocked: boolean;
}) {
  return (
    <>
      {note && note.text !== REPAY_COPY.closed && (
        <p
          role="status"
          className={`m-0 text-[13px] leading-snug ${note.tone === "act" ? "text-act" : "text-watch-text"}`}
        >
          {note.text}
        </p>
      )}
      {tick && <RiskTick checked={tick.checked} onChange={tick.onChange} label={RISK_TICK} />}
      {moved && (
        <p
          role="status"
          className="m-0 rounded-[14px] bg-watch-soft px-3.5 py-2.5 text-center text-[13px] font-semibold text-watch-ink"
        >
          Prices moved · amounts updated
        </p>
      )}
      {feeBlocked && (
        <p role="alert" className="m-0 text-[13px] text-act">
          {REPAY_COPY.feeUnsupported}
        </p>
      )}
    </>
  );
}

/**
 * The "Pay with" rows, the one picked and its view (planRepay). A stock reads two quotes: one for all the shares it can
 * sell, then one for the shares this amount sells.
 */
function useRepayView(data: RepayData | undefined, cfs: Record<string, number> | undefined, form: RepayForm) {
  const sources = data ? repaySources(data, cfs) : [];
  const source = pickedSource(sources, form.source);
  const stock = source && source.kind !== "cash" ? source : null;
  const maxQuote = useSellQuote(stock?.stock, stock?.maxSharesRaw ?? 0n);
  const sized = data && source ? planRepay({ data, source, form, maxQuote }) : null;
  const quote = useSellQuote(stock?.stock, sized?.sharesRaw ?? 0n);
  const view = data && source ? planRepay({ data, source, form, maxQuote, quote }) : null;
  return { sources, source, view };
}

/** What the sheet would sign for the row and amount on screen (null with no amount, or while it isn't ready). */
const signOf = (view: RepayView | null, data: RepayData | undefined, address: `0x${string}`) =>
  view && view.amountUsd > 0 && data ? repaySign(view, address, data.debtRaw) : null;

/** The stocks that back credit are still being read: the sheet waits for them. */
const waitsForCfs = (data: RepayData | undefined, cfRead: { cfs?: Record<string, number>; failed: boolean }) =>
  !!data && !cfRead.cfs && !cfRead.failed && data.holdings.some((h) => h.backingRaw > 0n);

/** Once the batch lands: the toast set at the tap (`done`), and the sheet closes. */
function useDoneToast(phase: string, onClose: () => void) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "done" || done.current === null) return;
    toast.success(done.current);
    done.current = null;
    onClose();
  }, [phase, onClose]);
  return done;
}

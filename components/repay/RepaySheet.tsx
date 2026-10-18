"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { Button } from "@/components/gg/Button";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useBackingFactorsRead, usePosition } from "@/hooks/usePosition";
import { repaySign, useRepayWith } from "@/hooks/useRepay";
import { useSellQuote } from "@/hooks/useSell";
import { freeAll, planFreeUp } from "@/lib/freeUpPlan";
import {
  REPAY_COPY,
  REPAY_FORM,
  noSourceLine,
  pickedSource,
  planRepay,
  repayForm,
  repaySheetSmallPrint,
  repaySources,
  type RepayAction,
  type RepayForm,
} from "@/lib/repay";
import { EQUITIES } from "@/lib/tokens/registry";
import { FreeUpList, type FreeUpItem } from "./FreeUpList";
import { OweCard } from "./OweCard";
import { PayBox } from "./PayBox";
import { RiskTick } from "./RiskTick";

/** A tap on the dim that just closed the Pay with list doesn't also close the sheet (the dim reports it after the list). */
const MENU_TAP_MS = 500;
const RISK_TICK = "I understand: if prices fall, part of my stocks can be sold.";

type Pick = { symbol: string; share: number; atRepayUsd: number };

const namesOf = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

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
  const [menu, setMenu] = useState(false);
  const [freeOpen, setFreeOpen] = useState(!!freeUp);
  // Ticked from the stock sheet: all of it, held to what the limit allows (no "prices moved" for that first cut).
  const [picks, setPicks] = useState<Pick[]>(freeUp ? [{ symbol: freeUp, share: 1, atRepayUsd: Number.NaN }] : []);
  const [ack, setAck] = useState(false);
  const menuClosedAt = useRef(0);
  const done = useRef<string | null>(null);

  const sources = data ? repaySources(data, cfRead.cfs) : [];
  const source = pickedSource(sources, form.source);
  const stock = source && source.kind !== "cash" ? source : null;
  const maxQuote = useSellQuote(stock?.stock, stock?.maxSharesRaw ?? 0n);
  const sized = data && source ? planRepay({ data, source, form, maxQuote }) : null;
  const quote = useSellQuote(stock?.stock, sized?.sharesRaw ?? 0n);
  const view = data && source ? planRepay({ data, source, form, maxQuote, quote }) : null;

  const repayUsd = view ? view.repayUsd || view.amountUsd : 0;
  const repaysAll = !!view && view.coversAll && view.amountUsd > 0;
  // The stocks that back credit and can be read. One being sold to pay can't be ticked too, but Repay all still takes
  // what's left of it out, after the sale.
  const selling = source?.kind === "backing" ? source.stock?.symbol : undefined;
  const backing = (data?.holdings ?? []).filter(
    (h) => h.backingRaw > 0n && cfRead.cfs?.[h.symbol] !== undefined && (repaysAll || h.symbol !== selling),
  );
  const stocks = backing.map((h) => ({
    symbol: h.symbol,
    backingRaw: h.backingRaw,
    backingUsd: h.backingUsd,
    cf: cfRead.cfs![h.symbol],
    paused: h.paused,
  }));
  const soldPower =
    source?.kind === "backing" && view?.sellPlan && source.stock && source.holding && cfRead.cfs
      ? (Number(view.sellPlan.sharesRaw) / 10 ** source.stock.decimals) *
        source.holding.priceUsd *
        (cfRead.cfs[source.stock.symbol] ?? 0)
      : 0;
  const plan = data
    ? planFreeUp({
        position: data,
        repayUsd,
        repaysAll,
        repayPowerOutUsd: soldPower,
        stocks,
        picks: repaysAll ? freeAll(stocks) : freeOpen ? picks : [],
      })
    : null;
  const takeOuts = (plan?.frees ?? []).flatMap((f) => {
    const asset = EQUITIES.find((e) => e.symbol === f.symbol);
    return asset ? [{ stock: asset, amountRaw: f.raw, all: f.all }] : [];
  });
  const changes = !!plan && (repayUsd > 0 || takeOuts.length > 0);
  // Every move in the batch (D7): the repay's, then each stock that comes out of backing.
  const smallPrint = changes
    ? repaySheetSmallPrint(
        view?.ready ? view : null,
        takeOuts.map((t) => ({
          ...t,
          multiplier: data?.holdings.find((h) => h.symbol === t.stock.symbol)?.multiplier ?? 10n ** 18n,
        })),
      )
    : null;
  // Prices moved under a ticked stock: the limit shrank with the repay unchanged, so its amount was cut.
  const moved =
    !!plan &&
    picks.some((p) => {
      const row = plan.rows.find((r) => r.symbol === p.symbol);
      return row?.picked && row.share < p.share - 1e-6 && Math.abs(p.atRepayUsd - repayUsd) < 1e-9;
    });

  const feeBlocked = isConnected && fee.state === "unsupported";
  const needsTick = !!plan?.risky && takeOuts.length > 0;
  const sign = view && view.amountUsd > 0 && data ? repaySign(view, address, data.debtRaw) : null;
  const tx = useRepayWith(sign, takeOuts, address, open && !feeBlocked && (!needsTick || ack));

  useEffect(() => {
    if (tx.phase !== "done" || done.current === null) return;
    toast.success(done.current);
    done.current = null;
    onClose();
  }, [tx.phase, onClose]);

  const dispatch = (action: RepayAction) => {
    if (tx.phase === "failed") tx.reset();
    setForm((f) => repayForm(f, action));
  };
  const closeMenu = (e?: Event) => {
    const inSheet = e?.target instanceof Element && !!e.target.closest('[role="dialog"]');
    if (!inSheet) menuClosedAt.current = Date.now();
    setMenu(false);
  };
  const onOpenChange = (next: boolean) => {
    if (next) return;
    if (menu) return setMenu(false);
    if (Date.now() - menuClosedAt.current < MENU_TAP_MS) return;
    onClose();
  };
  const waitingForCfs = !!data && !cfRead.cfs && !cfRead.failed && data.holdings.some((h) => h.backingRaw > 0n);

  const items: FreeUpItem[] = backing.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    shares: h.backingShares,
    usd: h.backingUsd,
  }));
  const freed = (plan?.rows ?? []).filter((r) => r.picked);
  const freedNames = freed.map((r) => backing.find((h) => h.symbol === r.symbol)?.name ?? r.symbol);
  const label = repaysAll
    ? "Repay all"
    : takeOuts.length > 0
      ? repayUsd > 0
        ? "Repay & free up"
        : "Free up"
      : REPAY_COPY.button;
  const doneLine = () => {
    const back = freed.length
      ? `${namesOf(freedNames)} ${freed.every((r) => r.all) ? (freed.length > 1 ? "are free" : "is free") : "freed up"}`
      : "";
    if (repaysAll) return REPAY_COPY.doneAll;
    if (repayUsd > 0 && view) return back ? `${view.done} · ${back}` : view.done;
    return back.charAt(0).toUpperCase() + back.slice(1);
  };
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
            {repaysAll ? (
              stocks.length > 0 && <AllBack />
            ) : !freeOpen ? (
              stocks.length > 0 && <AlsoFreeUp onOpen={() => setFreeOpen(true)} disabled={tx.busy} />
            ) : (
              <FreeUpList
                items={items}
                plan={plan}
                disabled={tx.busy}
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
            )}
            {view.note && view.note.text !== REPAY_COPY.closed && (
              <p
                role="status"
                className={`m-0 text-[13px] leading-snug ${view.note.tone === "act" ? "text-act" : "text-watch-text"}`}
              >
                {view.note.text}
              </p>
            )}
            {needsTick && <RiskTick checked={ack} onChange={setAck} label={RISK_TICK} />}
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
                done.current = doneLine();
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

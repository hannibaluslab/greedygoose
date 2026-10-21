"use client";

import { useEffect } from "react";
import { Layers } from "lucide-react";
import { assetMark } from "../kit/AssetPicker";
import { Button } from "../kit/Button";
import { PlusIcon } from "../kit/icons";
import { TxButton, TxError } from "../TxUi";
import type { TxPhase } from "@/hooks/useTx";
import type { PositionData } from "@/hooks/usePosition";
import { formatShares, formatUsd } from "@/lib/formatting";
import { MULTI_COPY, MULTI_MAX, MULTI_MIN, TRADE_COPY, type TradeAsset, type TradeRow } from "@/lib/trade";
import type { TradeSign } from "@/lib/tx/plans";
import { tickerOf } from "@/lib/tokens/registry";
import { tradeSign, useTradeView } from "./tradeView";

/*
 * Multi trade's list (NYM's MoveSheet multi mode, Adrian 2026-10-21): the total and how many trades, one row per trade
 * (tap to edit it in the Trade sheet's own editor), dashed places up to the two a list needs, then Add and the button
 * that signs every trade at once. Each row prices itself live, as the editor does (useTradeView), and says up what it
 * would sign, so the list's one batch is always built from fresh quotes.
 */

/** A row with an id, so a removed row doesn't hand its price to the next one. */
export type ListedRow = TradeRow & { id: number };

/** What a row says up: what it would sign now (null while it can't), its dollars, and why it can't. */
export type RowReport = { sign: TradeSign | null; amountUsd: number; blocker: string | null };

export function MultiList({
  rows,
  reports,
  onReport,
  onOpen,
  onAdd,
  settledId,
  user,
  data,
  nameOf,
  block,
  phase,
  checking,
  error,
  preview,
  canSign,
  onSign,
}: {
  rows: ListedRow[];
  reports: Record<number, RowReport>;
  onReport: (id: number, r: RowReport) => void;
  onOpen: (index: number) => void;
  onAdd: () => void;
  settledId: number | null;
  user: `0x${string}`;
  data: PositionData;
  nameOf: (asset: TradeAsset) => string;
  /** Why the rows can't go together (multiBlock), or a row's own block. */
  block: string | null;
  phase: TxPhase;
  checking: boolean;
  error: string | null;
  preview: boolean;
  canSign: boolean;
  onSign: () => void;
}) {
  const total = rows.reduce((sum, r) => sum + (reports[r.id]?.amountUsd ?? 0), 0);
  const busy = phase === "simulating" || phase === "signing" || phase === "pending";
  return (
    <div className="flex min-h-[420px] flex-col gap-3">
      <div className="flex flex-col items-start">
        <span
          className={`num text-[34px] font-semibold leading-tight tracking-[-0.02em] ${total ? "text-ink" : "text-ink-faint"}`}
        >
          {formatUsd(total)}
        </span>
        <span className="mt-0.5 text-[13px] text-ink-mid">{MULTI_COPY.sub(rows.length)}</span>
      </div>
      <div className="flex items-baseline justify-between px-0.5">
        <span className="label">{MULTI_COPY.eyebrow}</span>
        <span className={`font-mono text-[11px] ${rows.length >= MULTI_MIN ? "text-ink-mute" : "text-ink-faint"}`}>
          {MULTI_COPY.count(rows.length)}
        </span>
      </div>
      <ul aria-label={MULTI_COPY.eyebrow} className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((r, i) => (
          <LiveRow
            key={r.id}
            row={r}
            user={user}
            data={data}
            nameOf={nameOf}
            settled={r.id === settledId}
            disabled={busy}
            onReport={(rep) => onReport(r.id, rep)}
            onOpen={() => onOpen(i)}
          />
        ))}
        {Array.from({ length: Math.max(0, MULTI_MIN - rows.length) }, (_, i) => (
          <li
            key={`ghost-${i}`}
            aria-hidden
            className="flex h-[62px] items-center rounded-[18px] border border-dashed border-line-strong px-4 text-[14px] text-ink-faint"
          >
            {MULTI_COPY.ghost(rows.length + i + 1)}
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-col gap-2.5 pt-1">
        {block && (
          <p role="status" className="m-0 text-[13px] leading-snug text-act">
            {block}
          </p>
        )}
        <TxError error={error} />
        <p className="m-0 px-0.5 text-[12px] text-subtle">
          {rows.length >= MULTI_MAX ? MULTI_COPY.full : MULTI_COPY.oneSignature}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAdd}
            disabled={busy || rows.length >= MULTI_MAX}
            className="flex h-[52px] shrink-0 items-center gap-1.5 rounded-[26px] bg-brand/45 px-5 text-[15px] font-semibold text-ink disabled:opacity-45"
          >
            <PlusIcon size={16} />
            {MULTI_COPY.add}
          </button>
          <div className="min-w-0 grow">
            <TxButton
              label={MULTI_COPY.button(rows.length)}
              size="md"
              phase={phase}
              checking={checking}
              preview={preview}
              disabled={!canSign || phase === "done"}
              onClick={onSign}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The sheet's header corner: the Multi trade pill on a plain trade, Cancel on the list, nothing in the row editor. */
export function MultiHeader({
  show,
  onEnter,
  onExit,
  busy,
}: {
  show: "pill" | "cancel" | null;
  onEnter: () => void;
  onExit: () => void;
  busy: boolean;
}) {
  if (show === "pill")
    return (
      <button
        type="button"
        onClick={onEnter}
        className="inline-flex h-7 items-center gap-1.5 rounded-full bg-brand px-3 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink shadow-brand-glow"
      >
        <Layers size={11} strokeWidth={2.5} aria-hidden />
        {MULTI_COPY.pill}
      </button>
    );
  if (show === "cancel")
    return (
      <button
        type="button"
        onClick={onExit}
        disabled={busy}
        className="inline-flex h-7 items-center rounded-full bg-pill px-2.5 font-mono text-[11px] font-semibold text-ink-2 disabled:opacity-45"
      >
        {MULTI_COPY.cancel}
      </button>
    );
  return null;
}

/** The editor's foot in the list: Remove (a row already in it) and Done, once the trade could sign (the note above
 * says why it can't). */
export function RowButtons({
  canRemove,
  ready,
  onRemove,
  onDone,
}: {
  canRemove: boolean;
  ready: boolean;
  onRemove: () => void;
  onDone: () => void;
}) {
  return (
    <div className="mt-1 flex gap-2">
      {canRemove && (
        <Button variant="soft" onClick={onRemove} className="shrink-0">
          {MULTI_COPY.remove}
        </Button>
      )}
      <Button variant="primary" onClick={onDone} disabled={!ready} className="grow">
        {MULTI_COPY.done}
      </Button>
    </div>
  );
}

/** One trade in the list: both marks, "NVIDIA → Apple", what it gets (or why it can't), its dollars. Prices itself. */
function LiveRow({
  row,
  user,
  data,
  nameOf,
  settled,
  disabled,
  onReport,
  onOpen,
}: {
  row: ListedRow;
  user: `0x${string}`;
  data: PositionData;
  nameOf: (asset: TradeAsset) => string;
  settled: boolean;
  disabled: boolean;
  onReport: (r: RowReport) => void;
  onOpen: () => void;
}) {
  const view = useTradeView({ from: row.from, to: row.to, amount: row.amount, all: row.all, data }, true);
  const toPriceUsd = data.holdings.find((h) => h.symbol === row.to)?.priceUsd ?? 0;
  const sign = tradeSign(view, user, data.debtRaw, toPriceUsd);
  // Say up what this row would sign, whenever that changes (its quotes refresh on their own).
  const reportKey = `${view.amountUsd}|${view.blocker ?? ""}|${sign ? JSON.stringify(sign, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : "-"}`;
  useEffect(() => {
    onReport({ sign, amountUsd: view.amountUsd, blocker: view.blocker });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reportKey names everything the report reads
  }, [reportKey]);

  const gets =
    view.blocker ??
    (view.youGet.kind === "stock"
      ? view.youGet.shares === null
        ? MULTI_COPY.waiting
        : `≈ ${formatShares(view.youGet.shares)} ${tickerOf(view.youGet.symbol)}`
      : view.youGet.usd === null
        ? MULTI_COPY.waiting
        : `≈ ${formatUsd(view.youGet.usd)} ${TRADE_COPY.toCash.toLowerCase()}`);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className={`flex min-h-[62px] w-full items-center gap-3 rounded-[18px] bg-card px-3.5 py-2.5 text-left shadow-card-elev transition ${
          settled ? "ring-2 ring-brand" : ""
        }`}
      >
        <span aria-hidden className="flex shrink-0 items-center">
          {assetMark(row.from, 30)}
          <span className="-ml-2.5 rounded-full ring-2 ring-card">{assetMark(row.to, 30)}</span>
        </span>
        <span className="flex min-w-0 grow flex-col">
          <span className="truncate text-[15px] font-semibold leading-[1.25]">
            {nameOf(row.from)} → {nameOf(row.to)}
          </span>
          <span className={`truncate text-[12.5px] leading-[1.3] ${view.blocker ? "text-act" : "text-ink-mid"}`}>
            {gets}
          </span>
        </span>
        <span className="num shrink-0 text-[15px] font-semibold">{formatUsd(view.amountUsd)}</span>
      </button>
    </li>
  );
}

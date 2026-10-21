"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMultiTrade } from "@/hooks/useMultiTrade";
import type { PositionData } from "@/hooks/usePosition";
import { MULTI_COPY, MULTI_MIN, TRADE_COPY, defaultLegs, type TradeForm, type TradeRow } from "@/lib/trade";
import { multiBlock, type TradeSign } from "@/lib/tx/plans";
import type { ListedRow, RowReport } from "./MultiTrade";

/** Every row says it could sign now. */
const allSigned = (signs: (TradeSign | null)[]): signs is TradeSign[] => signs.every((s) => s !== null);

/**
 * Multi trade's state in the Trade sheet (NYM's multi mode): the list, the row the editor has open (`null`: a new
 * one), the row just back from the editor (a brief lime ring), and what each row would sign now. The list signs once
 * every row would and they fit together (cash for the buys, free shares per stock: multiBlock), in one batch. The
 * editor is the sheet's own form: opening a row puts its legs and amount there, Done takes them back. While the list
 * is open the plain trade signs nothing (`single`).
 */
export function useTradeList({
  open,
  user,
  data,
  fee,
  trade,
  could,
  setForm,
  onClose,
}: {
  open: boolean;
  user: `0x${string}`;
  data: PositionData;
  /** The network fee can't be paid here (`blocked`), or that's still being checked (`loading`). */
  fee: { blocked: boolean; loading: boolean };
  /** The trade in the editor now. */
  trade: TradeRow;
  /** What it would sign now: once it could, it comes along as the list's first row, and Done takes it in. */
  could: TradeSign | null;
  setForm: (form: TradeForm) => void;
  onClose: () => void;
}) {
  const [on, setOn] = useState(false);
  const [step, setStep] = useState<"edit" | "list">("edit");
  const [rows, setRows] = useState<ListedRow[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [nextId, setNextId] = useState(1);
  const [settledId, setSettledId] = useState<number | null>(null);
  const [reports, setReports] = useState<Record<number, RowReport>>({});

  const list = on && step === "list";
  const signs = rows.map((r) => reports[r.id]?.sign ?? null);
  const full = rows.length >= MULTI_MIN && allSigned(signs);
  const block = rows.some((r) => reports[r.id]?.blocker)
    ? MULTI_COPY.rowBlocked
    : full && allSigned(signs)
      ? multiBlock(signs, data)
      : null;
  const signable = open && list && !fee.blocked && !block && full && allSigned(signs) ? signs : null;
  const tx = useMultiTrade(user, signable);

  // Every trade landed: say so and close (each row's moves are in Activity).
  useEffect(() => {
    if (tx.phase !== "done") return;
    toast.success(MULTI_COPY.done_toast(rows.length));
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the list lands
  }, [tx.phase]);
  // The ring on a row back from the editor fades after a moment.
  useEffect(() => {
    if (settledId === null) return;
    const t = setTimeout(() => setSettledId(null), 700);
    return () => clearTimeout(t);
  }, [settledId]);

  const toList = () => {
    setEditing(null);
    setStep("list");
  };
  /** Into the list: the trade on screen comes along as its first row when it could sign. */
  const enter = () => {
    const first = could ? [{ ...trade, id: nextId }] : [];
    setRows(first);
    setNextId((n) => n + first.length);
    setOn(true);
    toList();
  };
  const exit = () => {
    setRows([]);
    setReports({});
    setEditing(null);
    setOn(false);
    setStep("edit");
  };
  /** A row into the editor, or a fresh trade (`null`). */
  const openRow = (index: number | null) => {
    tx.reset();
    const r = index === null ? null : rows[index];
    setForm({
      legs: r ? { from: r.from, to: r.to } : defaultLegs(data, {}),
      amount: r?.amount ?? "",
      all: r?.all ?? false,
    });
    setEditing(index);
    setStep("edit");
  };
  /** Done: the editor's trade into the list, where it was or at the end. */
  const commit = () => {
    const id = editing === null ? nextId : rows[editing].id;
    const row = { ...trade, id };
    setRows((prev) => (editing === null ? [...prev, row] : prev.map((x, i) => (i === editing ? row : x))));
    if (editing === null) setNextId((n) => n + 1);
    setSettledId(id);
    toList();
  };
  const remove = () => {
    if (editing !== null) setRows((prev) => prev.filter((_, i) => i !== editing));
    toList();
  };

  const editingRow = on && step === "edit";
  const title = !on
    ? TRADE_COPY.title
    : !editingRow
      ? MULTI_COPY.title
      : editing === null
        ? MULTI_COPY.newRow(rows.length + 1)
        : MULTI_COPY.rowOf(editing + 1, rows.length);
  return {
    on,
    list,
    editingRow,
    /** The editor has a row from the list open (it can be removed), not a new one. */
    editingSaved: editingRow && editing !== null,
    title,
    /** SheetSteps' key: the plain trade, the list, or a row in the editor. */
    stepKey: on ? `multi-${step}` : "trade",
    /** The header corner: Cancel on the list, the pill on a plain trade that can start one (`canStart`). */
    header: (canStart: boolean) => (list ? "cancel" : !on && canStart ? "pill" : null),
    rows,
    reports,
    report: (id: number, r: RowReport) => setReports((prev) => ({ ...prev, [id]: r })),
    settledId,
    block,
    tx,
    canSign: !!signable && !tx.blocked && !fee.loading,
    /** What the plain trade's button signs: nothing while the list is open. */
    single: open && !fee.blocked && !on ? could : null,
    enter,
    exit,
    openRow,
    commit,
    remove,
    /** Back from a row in the editor: its draft is dropped. */
    back: editingRow ? toList : undefined,
  };
}
